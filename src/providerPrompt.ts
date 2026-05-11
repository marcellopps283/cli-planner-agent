import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { execa } from "execa";

import { DEFAULT_PROVIDER_ADAPTERS, sanitizeProviderOutput } from "./providers.js";
import type { ProviderId } from "./schemas.js";

const DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS = 120_000;
const GEMINI_HEADLESS_ATTEMPTS = [
  { approvalMode: "plan", outputFormat: "json" },
  { approvalMode: "auto_edit", outputFormat: "json" },
  { approvalMode: "plan", outputFormat: "text" },
] as const;

export interface ProviderPromptOptions {
  provider: ProviderId;
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  timeoutMs?: number;
  onEvent?: ProviderPromptEventHandler;
}

export interface ProviderPromptResult {
  provider: ProviderId;
  model?: string;
  response: string;
  rawOutput: string;
}

export type ProviderPromptStreamName = "stdout" | "stderr";

export interface ProviderPromptEvent {
  type: "process_start" | "process_output" | "process_exit";
  provider: ProviderId;
  model?: string;
  stream?: ProviderPromptStreamName;
  message: string;
  detail?: string;
}

export type ProviderPromptEventHandler = (event: ProviderPromptEvent) => void;

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
  if (!model || isProviderCliDefaultModel(provider, model)) {
    return [];
  }

  if (provider === "openai" || provider === "google") {
    return ["-m", model];
  }

  return ["--model", model];
}

async function runCodexPrompt(options: ProviderPromptOptions, cwd: string): Promise<ProviderPromptResult> {
  const outputPath = join(cwd, "last-message.txt");
  emitProviderEvent(options, {
    type: "process_start",
    provider: "openai",
    model: options.model,
    message: `Starting codex exec for ${options.model ?? "default model"}.`,
  });
  const subprocess = execa(
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
      "--json",
      "-o",
      outputPath,
      "-",
    ],
    {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      input: options.prompt,
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  observeProviderProcessOutput(subprocess, options, "openai");
  const result = await subprocess;
  const stdout = stringifyProviderPromptOutput(result.stdout).trim();
  const stderr = stringifyProviderPromptOutput(result.stderr).trim();
  const rawOutput = [stdout, stderr].filter(Boolean).join("\n");
  emitProviderEvent(options, {
    type: "process_exit",
    provider: "openai",
    model: options.model,
    message: `codex exec exited with code ${result.exitCode ?? "unknown"}.`,
  });

  if (providerProcessFailed(result)) {
    throw new Error(`codex exec failed: ${summarizeProviderFailure(rawOutput || providerProcessFailure(result))}`);
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
  const errors: Array<{ label: string; summary: string }> = [];

  for (const attempt of GEMINI_HEADLESS_ATTEMPTS) {
    try {
      return await runGeminiPromptAttempt(options, cwd, attempt);
    } catch (error) {
      errors.push({
        label: `${attempt.approvalMode}/${attempt.outputFormat}`,
        summary: summarizeProviderFailure(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  throw new Error(summarizeProviderAttemptFailures("gemini", errors));
}

async function runGeminiPromptAttempt(
  options: ProviderPromptOptions,
  cwd: string,
  attempt: (typeof GEMINI_HEADLESS_ATTEMPTS)[number],
): Promise<ProviderPromptResult> {
  emitProviderEvent(options, {
    type: "process_start",
    provider: "google",
    model: options.model,
    message: `Starting gemini ${attempt.approvalMode}/${attempt.outputFormat} for ${options.model ?? "default model"}.`,
  });
  const subprocess = execa(
    "gemini",
    [
      ...providerPromptModelArgs("google", options.model),
      "-p",
      "Answer the complete Blueprint planner prompt supplied on stdin. Return only the requested final response.",
      "--skip-trust",
      "--approval-mode",
      attempt.approvalMode,
      ...(attempt.outputFormat === "json" ? ["--output-format", "json"] : []),
    ],
    {
      cwd,
      env: { NO_COLOR: "1" },
      reject: false,
      input: promptWithReasoningEffort(options.prompt, options.reasoningEffort),
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  observeProviderProcessOutput(subprocess, options, "google");
  const result = await subprocess;
  const rawOutput = selectProviderPromptOutput(result.stdout, result.stderr);
  emitProviderEvent(options, {
    type: "process_exit",
    provider: "google",
    model: options.model,
    message: `gemini exited with code ${result.exitCode ?? "unknown"}.`,
  });

  if (providerProcessFailed(result)) {
    throw new Error(`gemini failed: ${summarizeProviderFailure(rawOutput || providerProcessFailure(result))}`);
  }

  if (!rawOutput) {
    throw new Error(`gemini returned no stdout/stderr: ${providerProcessFailure(result)}`);
  }

  const response =
    attempt.outputFormat === "json"
      ? geminiJsonResponse(rawOutput)
      : rawOutput;

  return {
    provider: "google",
    model: options.model,
    response: response.trim(),
    rawOutput,
  };
}

async function runClaudePrompt(options: ProviderPromptOptions, cwd: string): Promise<ProviderPromptResult> {
  emitProviderEvent(options, {
    type: "process_start",
    provider: "anthropic",
    model: options.model,
    message: `Starting claude -p for ${options.model ?? "default model"}.`,
  });
  const subprocess = execa(
    "claude",
    [
      "-p",
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
      input: options.prompt,
      timeout: options.timeoutMs ?? DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
    },
  );
  observeProviderProcessOutput(subprocess, options, "anthropic");
  const result = await subprocess;
  const rawOutput = selectProviderPromptOutput(result.stdout, result.stderr);
  emitProviderEvent(options, {
    type: "process_exit",
    provider: "anthropic",
    model: options.model,
    message: `claude exited with code ${result.exitCode ?? "unknown"}.`,
  });

  if (providerProcessFailed(result)) {
    throw new Error(`claude failed: ${summarizeProviderFailure(rawOutput || providerProcessFailure(result))}`);
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

export function isProviderCliDefaultModel(provider: ProviderId, model: string): boolean {
  const normalized = model.trim().toLowerCase();

  if (provider === "openai") {
    return normalized === "openai-codex-default" || normalized === "codex-cli-default";
  }

  if (provider === "google") {
    return normalized === "gemini-cli-default" || normalized === "google-gemini-default";
  }

  return normalized === "claude-code-default" || normalized === "anthropic-claude-default";
}

function promptWithReasoningEffort(prompt: string, effort?: string): string {
  if (!effort) {
    return prompt;
  }

  return [`Requested reasoning effort for this run: ${effort}.`, prompt].join("\n\n");
}

function geminiJsonResponse(rawOutput: string): string {
  const parsed = parseProviderJson(rawOutput);
  return typeof parsed.response === "string" ? parsed.response : rawOutput;
}

export function selectProviderPromptOutput(stdout: unknown, stderr: unknown): string {
  return stringifyProviderPromptOutput(stdout).trim() || stringifyProviderPromptOutput(stderr).trim();
}

function providerProcessFailed(result: { exitCode?: number; failed?: boolean }): boolean {
  if (result.failed === true) {
    return true;
  }

  return typeof result.exitCode === "number" && result.exitCode !== 0;
}

function providerProcessFailure(result: {
  exitCode?: number;
  timedOut?: boolean;
  signal?: string;
  signalDescription?: string;
  killed?: boolean;
  failed?: boolean;
  isCanceled?: boolean;
}): string {
  if (result.timedOut) {
    return "process timed out without stdout/stderr";
  }

  if (result.isCanceled) {
    return "process was canceled before stdout/stderr was reported";
  }

  if (result.signal) {
    return `process ended with signal ${result.signal}${result.signalDescription ? ` ${result.signalDescription}` : ""}`;
  }

  if (typeof result.exitCode === "number") {
    return `exit code ${result.exitCode}`;
  }

  if (result.killed) {
    return "process was killed without stdout/stderr";
  }

  if (result.failed) {
    return "process failed without stdout/stderr, exit code, signal, or timeout details";
  }

  return "process ended without stdout/stderr and no exit code was reported";
}

function stringifyProviderPromptOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (output === undefined || output === null) {
    return "";
  }

  return String(output);
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

function summarizeProviderAttemptFailures(provider: string, errors: Array<{ label: string; summary: string }>): string {
  const labels = errors.map((error) => error.label).join(", ");
  const uniqueSummaries = [...new Set(errors.map((error) => error.summary))];

  if (uniqueSummaries.length === 1) {
    return `${provider} failed after ${errors.length} headless attempt(s) (${labels}): ${uniqueSummaries[0]}`;
  }

  return `${provider} failed after ${errors.length} headless attempt(s): ${errors
    .map((error) => `${error.label}: ${error.summary}`)
    .join(" | ")}`;
}

function observeProviderProcessOutput(
  subprocess: {
    stdout?: Readable | null;
    stderr?: Readable | null;
  },
  options: ProviderPromptOptions,
  provider: ProviderId,
): void {
  observeProviderStream(subprocess.stdout, options, provider, "stdout");
  observeProviderStream(subprocess.stderr, options, provider, "stderr");
}

function observeProviderStream(
  stream: Readable | null | undefined,
  options: ProviderPromptOptions,
  provider: ProviderId,
  streamName: ProviderPromptStreamName,
): void {
  if (!stream || !options.onEvent) {
    return;
  }

  stream.setEncoding("utf8");
  let buffer = "";

  stream.on("data", (chunk: string | Buffer) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      emitProviderOutputLine(options, provider, streamName, line);
    }

    if (buffer.length > 800) {
      emitProviderOutputLine(options, provider, streamName, buffer);
      buffer = "";
    }
  });

  stream.on("end", () => {
    if (buffer.trim().length > 0) {
      emitProviderOutputLine(options, provider, streamName, buffer);
      buffer = "";
    }
  });
}

function emitProviderOutputLine(
  options: ProviderPromptOptions,
  provider: ProviderId,
  stream: ProviderPromptStreamName,
  line: string,
): void {
  const summary = summarizeProviderStreamLine(line);

  if (!summary) {
    return;
  }

  emitProviderEvent(options, {
    type: "process_output",
    provider,
    model: options.model,
    stream,
    message: summary,
    detail: stream,
  });
}

function summarizeProviderStreamLine(line: string): string | undefined {
  const sanitized = sanitizeProviderOutput(line).replace(/\s+/gu, " ").trim();

  if (!sanitized) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(sanitized) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const type = stringField(record, "type") ?? stringField(record, "event") ?? stringField(record, "status");
      const message =
        stringField(record, "message")
        ?? stringField(record, "msg")
        ?? stringField(record, "summary")
        ?? stringField(record, "text")
        ?? stringField(record, "delta");

      if (type && message) {
        return truncateProviderEvent(`${type}: ${message}`);
      }

      if (message) {
        return truncateProviderEvent(message);
      }

      if (type) {
        return truncateProviderEvent(`provider event ${type}`);
      }

      return truncateProviderEvent(`provider json ${Object.keys(record).slice(0, 5).join(",") || "event"}`);
    }
  } catch {
    // Non-JSON provider output is handled below.
  }

  return truncateProviderEvent(sanitized);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateProviderEvent(value: string): string {
  return value.length > 180 ? `${value.slice(0, 180)}...` : value;
}

function emitProviderEvent(options: ProviderPromptOptions, event: ProviderPromptEvent): void {
  options.onEvent?.(event);
}
