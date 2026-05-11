import {
  runProviderPrompt,
  type ProviderPromptEvent,
  type ProviderPromptOptions,
  type ProviderPromptResult,
  type ProviderPromptStreamName,
} from "./providerPrompt.js";
import type { ProviderId } from "./schemas.js";

const DEFAULT_REPAIR_ATTEMPTS = 1;

export type PlannerPromptRunner = (options: ProviderPromptOptions) => Promise<ProviderPromptResult>;

export interface PlannerEngineStreamEvent {
  type:
    | "attempt_start"
    | "provider_output"
    | "provider_exit"
    | "parse_start"
    | "parse_ok"
    | "parse_invalid"
    | "repair_start"
    | "provider_failed";
  provider: ProviderId;
  model: string;
  attempt: number;
  repair: boolean;
  message: string;
  detail?: string;
  stream?: ProviderPromptStreamName;
}

export type PlannerEngineStreamEventHandler = (event: PlannerEngineStreamEvent) => void;

export interface PlannerEngineAttempt {
  provider: ProviderId;
  model: string;
  attempt: number;
  repair: boolean;
  status: "ok" | "invalid" | "failed";
  detail: string;
}

export interface RunLlmPlannerEngineOptions<TDraft> {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
  prompt: string;
  parseDraft: (response: string) => TDraft;
  timeoutMs?: number;
  repairAttempts?: number;
  runner?: PlannerPromptRunner;
  onEvent?: PlannerEngineStreamEventHandler;
}

export interface LlmPlannerEngineResult<TDraft> {
  provider: ProviderId;
  model: string;
  draft: TDraft;
  attempts: PlannerEngineAttempt[];
}

export class PlannerEngineError extends Error {
  readonly attempts: PlannerEngineAttempt[];

  constructor(message: string, attempts: PlannerEngineAttempt[]) {
    super(message);
    this.name = "PlannerEngineError";
    this.attempts = attempts;
  }
}

export async function runLlmPlannerEngine<TDraft>(
  options: RunLlmPlannerEngineOptions<TDraft>,
): Promise<LlmPlannerEngineResult<TDraft>> {
  const runner = options.runner ?? runProviderPrompt;
  const maxAttempts = 1 + (options.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS);
  const attempts: PlannerEngineAttempt[] = [];
  let prompt = options.prompt;
  let lastResponse = "";

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const repair = attemptIndex > 0;
    const attempt = attemptIndex + 1;

    emitPlannerEngineEvent(options, {
      type: "attempt_start",
      provider: options.provider,
      model: options.model,
      attempt,
      repair,
      message: repair
        ? `Asking ${options.provider}/${options.model} to repair the planner JSON.`
        : `Calling ${options.provider}/${options.model} for planner workflow state.`,
    });

    try {
      const result = await runner({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        prompt,
        timeoutMs: options.timeoutMs,
        onEvent: (event) => {
          emitPlannerEngineEvent(options, mapProviderEventToPlannerEvent(event, attempt, repair, options.model));
        },
      });

      lastResponse = result.response;
      emitPlannerEngineEvent(options, {
        type: "parse_start",
        provider: options.provider,
        model: options.model,
        attempt,
        repair,
        message: `Validating planner response from ${options.provider}/${options.model}.`,
        detail: `response_chars=${result.response.length}`,
      });

      try {
        const draft = options.parseDraft(result.response);

        attempts.push({
          provider: options.provider,
          model: options.model,
          attempt,
          repair,
          status: "ok",
          detail: `response_chars=${result.response.length}`,
        });
        emitPlannerEngineEvent(options, {
          type: "parse_ok",
          provider: options.provider,
          model: options.model,
          attempt,
          repair,
          message: `Planner response accepted from ${options.provider}/${options.model}.`,
          detail: `response_chars=${result.response.length}`,
        });

        return {
          provider: options.provider,
          model: options.model,
          draft,
          attempts,
        };
      } catch (error) {
        const detail = summarizeEngineError(error);

        attempts.push({
          provider: options.provider,
          model: options.model,
          attempt,
          repair,
          status: "invalid",
          detail,
        });
        emitPlannerEngineEvent(options, {
          type: "parse_invalid",
          provider: options.provider,
          model: options.model,
          attempt,
          repair,
          message: `Planner response failed validation: ${detail}`,
          detail,
        });

        if (attemptIndex === maxAttempts - 1) {
          throw new PlannerEngineError(`Planner returned invalid JSON: ${detail}`, attempts);
        }

        prompt = buildPlannerRepairPrompt(options.prompt, result.response, detail);
        emitPlannerEngineEvent(options, {
          type: "repair_start",
          provider: options.provider,
          model: options.model,
          attempt: attempt + 1,
          repair: true,
          message: `Preparing repair prompt for ${options.provider}/${options.model}.`,
          detail,
        });
      }
    } catch (error) {
      if (error instanceof PlannerEngineError) {
        throw error;
      }

      const detail = summarizeEngineError(error);

      attempts.push({
        provider: options.provider,
        model: options.model,
        attempt,
        repair,
        status: "failed",
        detail,
      });
      emitPlannerEngineEvent(options, {
        type: "provider_failed",
        provider: options.provider,
        model: options.model,
        attempt,
        repair,
        message: `Planner provider call failed: ${detail}`,
        detail,
      });

      throw new PlannerEngineError(`Planner provider call failed: ${detail}`, attempts);
    }
  }

  throw new PlannerEngineError(
    `Planner failed without a usable response. Last response chars: ${lastResponse.length}.`,
    attempts,
  );
}

function mapProviderEventToPlannerEvent(
  event: ProviderPromptEvent,
  attempt: number,
  repair: boolean,
  fallbackModel: string,
): PlannerEngineStreamEvent {
  const model = event.model ?? fallbackModel;

  if (event.type === "process_output") {
    return {
      type: "provider_output",
      provider: event.provider,
      model,
      attempt,
      repair,
      stream: event.stream,
      message: event.message,
      detail: event.detail,
    };
  }

  if (event.type === "process_exit") {
    return {
      type: "provider_exit",
      provider: event.provider,
      model,
      attempt,
      repair,
      message: event.message,
      detail: event.detail,
    };
  }

  return {
    type: "attempt_start",
    provider: event.provider,
    model,
    attempt,
    repair,
    message: event.message,
    detail: event.detail,
  };
}

function emitPlannerEngineEvent(
  options: RunLlmPlannerEngineOptions<unknown>,
  event: PlannerEngineStreamEvent,
): void {
  options.onEvent?.(event);
}

export function buildPlannerRepairPrompt(originalPrompt: string, invalidResponse: string, error: string): string {
  return [
    "Your previous planner response failed validation.",
    `Validation error: ${error}`,
    "Return a corrected JSON object only. Do not include markdown fences or commentary.",
    "Preserve the user's planning intent, use only active model ids, and keep dependencies pointing only to earlier tasks.",
    "Original planner instructions:",
    truncateForRepair(originalPrompt, 12_000),
    "Invalid response to repair:",
    truncateForRepair(invalidResponse, 8_000),
  ].join("\n\n");
}

function summarizeEngineError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message.replace(/\s+/gu, " ").trim();

  if (sanitized.length === 0) {
    return "unknown error";
  }

  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
}

function truncateForRepair(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}
