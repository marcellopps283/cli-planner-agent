import { describe, expect, it } from "vitest";

import { PlannerEngineError, runLlmPlannerEngine } from "../src/plannerEngine.js";

describe("planner engine", () => {
  it("runs the selected provider/model and parses the draft", async () => {
    const calls: Array<{ provider: string; model?: string; prompt: string }> = [];
    const result = await runLlmPlannerEngine({
      provider: "openai",
      model: "gpt-5.5",
      prompt: "make a plan",
      parseDraft: (response) => JSON.parse(response) as { ok: boolean },
      runner: async (options) => {
        calls.push({ provider: options.provider, model: options.model, prompt: options.prompt });
        return {
          provider: options.provider,
          model: options.model,
          response: '{"ok":true}',
          rawOutput: "",
        };
      },
    });

    expect(result.draft).toEqual({ ok: true });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.attempts).toEqual([
      {
        provider: "openai",
        model: "gpt-5.5",
        attempt: 1,
        repair: false,
        status: "ok",
        detail: "response_chars=11",
      },
    ]);
    expect(calls).toEqual([{ provider: "openai", model: "gpt-5.5", prompt: "make a plan" }]);
  });

  it("retries once with a repair prompt when JSON validation fails", async () => {
    const prompts: string[] = [];
    const responses = ["not json", '{"ok":true}'];
    const result = await runLlmPlannerEngine({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      prompt: "original prompt",
      parseDraft: (response) => JSON.parse(response) as { ok: boolean },
      runner: async (options) => {
        prompts.push(options.prompt);
        return {
          provider: options.provider,
          model: options.model,
          response: responses.shift()!,
          rawOutput: "",
        };
      },
    });

    expect(result.draft.ok).toBe(true);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["invalid", "ok"]);
    expect(prompts[1]).toContain("failed validation");
    expect(prompts[1]).toContain("Invalid response to repair");
  });

  it("exposes failed attempts when provider execution fails", async () => {
    await expect(
      runLlmPlannerEngine({
        provider: "anthropic",
        model: "claude-opus-4-7",
        prompt: "make a plan",
        parseDraft: (response) => JSON.parse(response) as { ok: boolean },
        runner: async () => {
          throw new Error("quota unavailable");
        },
      }),
    ).rejects.toMatchObject({
      name: "PlannerEngineError",
      message: "Planner provider call failed: quota unavailable",
      attempts: [
        {
          provider: "anthropic",
          model: "claude-opus-4-7",
          attempt: 1,
          repair: false,
          status: "failed",
          detail: "quota unavailable",
        },
      ],
    } satisfies Partial<PlannerEngineError>);
  });
});
