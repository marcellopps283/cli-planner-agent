import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import type { ProviderAdapter } from "./schemas.js";

const DEFAULT_LIVE_CHECK_TIMEOUT_MS = 45_000;

export const DEFAULT_PROVIDER_ADAPTERS: ProviderAdapter[] = [
  {
    id: "openai",
    cli: "codex",
    enabled: true,
    authStatusCommand: ["codex", "login", "status"],
    liveCheckCommand: [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "Reply with exactly OK.",
    ],
    nonInteractiveCommand: ["codex", "exec"],
  },
  {
    id: "anthropic",
    cli: "claude",
    enabled: true,
    authStatusCommand: ["claude", "auth", "status"],
    liveCheckCommand: [
      "claude",
      "-p",
      "Reply with exactly OK.",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
    ],
    nonInteractiveCommand: ["claude", "-p"],
  },
  {
    id: "google",
    cli: "gemini",
    enabled: true,
    liveCheckCommand: [
      "gemini",
      "-p",
      "Reply with exactly OK.",
      "--output-format",
      "json",
      "--approval-mode",
      "plan",
    ],
    nonInteractiveCommand: ["gemini", "-p"],
  },
];

export interface ProviderDoctorResult {
  id: ProviderAdapter["id"];
  cli: string;
  installed: boolean;
  authCheck: "ok" | "not_checked" | "failed";
  detail: string;
}

export interface ProviderAuthCheckOptions {
  live?: boolean;
  liveTimeoutMs?: number;
}

export async function checkProvider(adapter: ProviderAdapter): Promise<ProviderDoctorResult> {
  try {
    const result = await execa(adapter.cli, ["--version"], { reject: false });
    const detail = sanitizeProviderOutput(result.stdout.trim() || result.stderr.trim() || "installed");

    return {
      id: adapter.id,
      cli: adapter.cli,
      installed: result.exitCode === 0,
      authCheck: "not_checked",
      detail,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";

    return {
      id: adapter.id,
      cli: adapter.cli,
      installed: false,
      authCheck: "failed",
      detail,
    };
  }
}

export async function checkProviderAuth(
  adapter: ProviderAdapter,
  options: ProviderAuthCheckOptions = {},
): Promise<ProviderDoctorResult> {
  const base = await checkProvider(adapter);

  if (!base.installed) {
    return base;
  }

  if (!adapter.authStatusCommand) {
    if (options.live && adapter.liveCheckCommand) {
      return checkProviderLive(adapter, base, options);
    }

    return base;
  }

  const [command, ...args] = adapter.authStatusCommand;

  if (!command) {
    return base;
  }

  const result = await execa(command, args, { reject: false });
  const detail = summarizeAuthOutput(result.stdout.trim() || result.stderr.trim() || base.detail);
  const authResult: ProviderDoctorResult = {
    ...base,
    authCheck: result.exitCode === 0 ? "ok" : "failed",
    detail,
  };

  if (options.live && authResult.authCheck === "ok" && adapter.liveCheckCommand) {
    return checkProviderLive(adapter, authResult, options);
  }

  return authResult;
}

export async function checkProviderLive(
  adapter: ProviderAdapter,
  base: ProviderDoctorResult,
  options: ProviderAuthCheckOptions = {},
): Promise<ProviderDoctorResult> {
  if (!adapter.liveCheckCommand) {
    return base;
  }

  const [command, ...args] = adapter.liveCheckCommand;

  if (!command) {
    return base;
  }

  const cwd = await mkdtemp(join(tmpdir(), "blueprint-provider-smoke-"));

  try {
    const result = await execa(command, args, {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      stdin: "ignore",
      timeout: options.liveTimeoutMs ?? DEFAULT_LIVE_CHECK_TIMEOUT_MS,
    });
    const output = selectLiveSmokeOutput(adapter.id, result.stdout, result.stderr);
    const success = isProviderLiveCheckSuccessful(adapter.id, result.exitCode, output);

    return {
      ...base,
      authCheck: success ? "ok" : "failed",
      detail: summarizeLiveSmokeOutput(adapter.id, output || base.detail),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";

    return {
      ...base,
      authCheck: "failed",
      detail: sanitizeProviderOutput(detail),
    };
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

export function isProviderLiveSmokeSuccessful(providerId: ProviderAdapter["id"], output: string): boolean {
  if (providerId === "google" || providerId === "anthropic") {
    return getProviderResponse(providerId, output).trim().toUpperCase().replace(/\.$/u, "") === "OK";
  }

  return /\bOK\.?\b/iu.test(output);
}

export function isProviderLiveCheckSuccessful(
  providerId: ProviderAdapter["id"],
  exitCode: number | undefined,
  output: string,
): boolean {
  if (!isProviderLiveSmokeSuccessful(providerId, output)) {
    return false;
  }

  if (exitCode === 0) {
    return true;
  }

  // Codex can emit the final answer and still return non-zero when it cannot
  // write optional session metadata in constrained terminals. Trust the answer
  // for the smoke, but keep stricter exit-code handling for structured CLIs.
  return providerId === "openai";
}

export function summarizeLiveSmokeOutput(providerId: ProviderAdapter["id"], output: string): string {
  if (providerId === "google") {
    return summarizeGeminiLiveOutput(output);
  }

  if (providerId === "anthropic") {
    return summarizeClaudeLiveOutput(output);
  }

  return summarizeGenericLiveOutput(providerId, output);
}

export function summarizeGeminiLiveOutput(output: string): string {
  const parsed = parseJsonObject(output);

  if (!parsed) {
    return `response=unexpected detail=${truncateDetail(sanitizeProviderOutput(output))}`;
  }

  const parts = [`response=${isProviderLiveSmokeSuccessful("google", output) ? "OK" : "unexpected"}`];

  const stats = getNestedRecord(parsed, "stats");
  const modelStats = getFirstNestedRecord(getNestedRecord(stats, "models"));
  const model = typeof parsed?.model === "string" ? parsed.model : modelStats?.key;

  if (model) {
    parts.push(`model=${sanitizeProviderOutput(model)}`);
  }

  const usage = getNestedRecord(parsed, "usageMetadata");
  const modelTokens = getNestedRecord(modelStats?.value, "tokens");
  const inputTokens =
    getNumber(stats?.inputTokens) ?? getNumber(usage?.promptTokenCount) ?? getNumber(modelTokens?.input);
  const outputTokens =
    getNumber(stats?.outputTokens) ?? getNumber(usage?.candidatesTokenCount) ?? getNumber(modelTokens?.candidates);

  if (inputTokens !== undefined) {
    parts.push(`inputTokens=${inputTokens}`);
  }

  if (outputTokens !== undefined) {
    parts.push(`outputTokens=${outputTokens}`);
  }

  return parts.join(" ");
}

export function summarizeClaudeLiveOutput(output: string): string {
  const parsed = parseJsonObject(output);

  if (!parsed) {
    return summarizeGenericLiveOutput("anthropic", output);
  }

  const parts = [`response=${isProviderLiveSmokeSuccessful("anthropic", output) ? "OK" : "unexpected"}`];

  if (typeof parsed.api_error_status === "number") {
    parts.push(`apiError=${parsed.api_error_status}`);
  }

  const usage = getNestedRecord(parsed, "usage");
  const inputTokens = getNumber(usage?.input_tokens);
  const outputTokens = getNumber(usage?.output_tokens);

  if (inputTokens !== undefined) {
    parts.push(`inputTokens=${inputTokens}`);
  }

  if (outputTokens !== undefined) {
    parts.push(`outputTokens=${outputTokens}`);
  }

  if (parts[0] === "response=unexpected" && typeof parsed.result === "string") {
    parts.push(`detail=${truncateDetail(sanitizeProviderOutput(parsed.result), 120)}`);
  }

  return parts.join(" ");
}

export function summarizeGenericLiveOutput(providerId: ProviderAdapter["id"], output: string): string {
  const success = isProviderLiveSmokeSuccessful(providerId, output);

  if (success) {
    return "response=OK";
  }

  return `response=unexpected detail=${truncateDetail(sanitizeProviderOutput(output))}`;
}

export function summarizeAuthOutput(output: string): string {
  const trimmed = output.trim();

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const parts: string[] = [];

    if (typeof parsed.loggedIn === "boolean") {
      parts.push(`loggedIn=${parsed.loggedIn}`);
    }

    if (typeof parsed.authMethod === "string") {
      parts.push(`authMethod=${parsed.authMethod}`);
    }

    if (typeof parsed.apiProvider === "string") {
      parts.push(`apiProvider=${parsed.apiProvider}`);
    }

    if (typeof parsed.subscriptionType === "string") {
      parts.push(`subscriptionType=${parsed.subscriptionType}`);
    }

    if (parts.length > 0) {
      return parts.join(" ");
    }
  } catch {
    // Plain text provider output is handled by the sanitizer below.
  }

  return sanitizeProviderOutput(trimmed);
}

export function sanitizeProviderOutput(output: string): string {
  return output
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/\b[A-F0-9]{8}-[A-F0-9]{4}-[1-5][A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}\b/giu, "[redacted-id]")
    .replace(/\b(?:sk|sess|token|Bearer)[A-Za-z0-9._~+/=-]{12,}\b/gu, "[redacted-secret]");
}

function selectLiveSmokeOutput(providerId: ProviderAdapter["id"], stdout: string, stderr: string): string {
  const normalizedStdout = stdout.trim();
  const normalizedStderr = stderr.trim();

  if (providerId === "openai") {
    return [normalizedStdout, normalizedStderr].filter(Boolean).join("\n");
  }

  return normalizedStdout || normalizedStderr;
}

function getProviderResponse(providerId: ProviderAdapter["id"], output: string): string {
  const parsed = parseJsonObject(output);

  if (providerId === "google" && typeof parsed?.response === "string") {
    return parsed.response;
  }

  if (providerId === "anthropic" && typeof parsed?.result === "string") {
    return parsed.result;
  }

  return output;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getNestedRecord(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function getFirstNestedRecord(
  source: Record<string, unknown> | undefined,
): { key: string; value: Record<string, unknown> } | undefined {
  if (!source) {
    return undefined;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { key, value: value as Record<string, unknown> };
    }
  }

  return undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateDetail(output: string, maxLength = 240): string {
  return output.length > maxLength ? `${output.slice(0, maxLength)}...` : output;
}
