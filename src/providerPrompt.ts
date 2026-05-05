import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { DEFAULT_PROVIDER_ADAPTERS, sanitizeProviderOutput } from "./providers.js";
import type { ProviderId } from "./schemas.js";

const DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS = 120_000;

export interface ProviderPromptOptions {
  provider: ProviderId;
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  timeoutMs?: number;
}

export interface ProviderPromptResult {
  provider: ProviderId;
  model?: string;
  response: string;
  rawOutput: string;
}

export async function runProviderPrompt(options: ProviderPromptOptions): Promise<ProviderPromptResult> {
  const adapter = DEFAULT_PROVIDER_ADAPTERS.find((candidate) => candidate.id === options.provider);

  if (!adapter) {
    throw new Error(`No provider adapter configured for ${options.provider}.`);
  }

  const cwd = await mkdtemp(join(tmpdir(), "blueprint-planner-prompt-"));

  try {
    if (adapter.id === "openai") {
      return await runCodexPrompt(options, cwd);
    }

    if (adapter.id === "google") {
      return await runGeminiPrompt(options, cwd);
    }

    if (adapter.id === "anthropic") {
      return await runClaudePrompt(options, cwd);
    }

    throw new Error(`Provider ${adapter.id} does not support prompt execution yet.`);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue with fenced or embedded JSON extraction.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);

  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    JSON.parse(candidate);
    return candidate;
  }

  throw new Error("Provider response did not contain a JSON object.");
}

export function providerPromptModelArgs(provider: ProviderId, model?: string): string[] {
  if (!model) {
    return [];
  }

  if (provider === "openai" || provider === "google") {
    return ["-m", model];
  }

  return ["--model", model];
}

async function runCodexPrompt(options: ProviderPromptOptions, cwd: string): Promise<ProviderPromptResult> {
  const outputPath = join(cwd, "last-message.txt");
  const result = await execa(
    "codex",
    [
      "exec",
      ...providerPromptModelArgs("openai", options.model),
      ...providerPromptReasoningArgs("openai", options.reasoningEffort),
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-o",
      outputPath,
      options.prompt,
    ],
    {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      stdin: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  const rawOutput = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    throw new Error(`codex exec failed: ${summarizeProviderFailure(rawOutput || `exit code ${result.exitCode}`)}`);
  }

  const response = await readFile(outputPath, "utf8");

  return {
    provider: "openai",
    model: options.model,
    response: response.trim(),
    rawOutput,
  };
}

async function runGeminiPrompt(options: ProviderPromptOptions, cwd: string): Promise<ProviderPromptResult> {
  const result = await execa(
    "gemini",
    [
      ...providerPromptModelArgs("google", options.model),
      "-p",
      promptWithReasoningEffort(options.prompt, options.reasoningEffort),
      "--skip-trust",
      "--output-format",
      "json",
      "--approval-mode",
      "plan",
    ],
    {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      stdin: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  const rawOutput = result.stdout.trim() || result.stderr.trim();

  if (result.exitCode !== 0) {
    throw new Error(`gemini failed: ${summarizeProviderFailure(rawOutput || `exit code ${result.exitCode}`)}`);
  }

  const parsed = parseProviderJson(rawOutput);
  const response = typeof parsed.response === "string" ? parsed.response : rawOutput;

  return {
    provider: "google",
    model: options.model,
    response: response.trim(),
    rawOutput,
  };
}

async function runClaudePrompt(options: ProviderPromptOptions, cwd: string): Promise<ProviderPromptResult> {
  const result = await execa(
    "claude",
    [
      "-p",
      options.prompt,
      ...providerPromptModelArgs("anthropic", options.model),
      ...providerPromptReasoningArgs("anthropic", options.reasoningEffort),
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
    ],
    {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      stdin: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  const rawOutput = result.stdout.trim() || result.stderr.trim();

  if (result.exitCode !== 0) {
    throw new Error(`claude failed: ${summarizeProviderFailure(rawOutput || `exit code ${result.exitCode}`)}`);
  }

  const parsed = parseProviderJson(rawOutput);

  if (parsed.is_error === true || typeof parsed.api_error_status === "number") {
    throw new Error(`claude returned an API error: ${sanitizeProviderOutput(String(parsed.result ?? rawOutput))}`);
  }

  const response = typeof parsed.result === "string" ? parsed.result : rawOutput;

  return {
    provider: "anthropic",
    model: options.model,
    response: response.trim(),
    rawOutput,
  };
}

export function providerPromptReasoningArgs(provider: ProviderId, effort?: string): string[] {
  if (!effort) {
    return [];
  }

  if (provider === "anthropic") {
    return ["--effort", effort];
  }

  if (provider === "openai" && effort !== "none") {
    return ["-c", `model_reasoning_effort="${effort}"`];
  }

  return [];
}

function promptWithReasoningEffort(prompt: string, effort?: string): string {
  if (!effort) {
    return prompt;
  }

  return [`Requested reasoning effort for this run: ${effort}.`, prompt].join("\n\n");
}

function parseProviderJson(rawOutput: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawOutput) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Handled below.
  }

  throw new Error("Provider response was not valid JSON.");
}

function summarizeProviderFailure(rawOutput: string): string {
  const lines = sanitizeProviderOutput(rawOutput)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const signalLines = lines.filter((line) => /error|limit|quota|access|failed|forbidden|unauthorized/iu.test(line));
  const selected = signalLines.length > 0 ? signalLines.slice(-3) : lines.slice(-5);
  const summary = selected.join(" ");

  if (summary.length === 0) {
    return "unknown provider failure";
  }

  return summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
}
