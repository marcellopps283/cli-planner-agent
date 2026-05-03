import { describe, expect, it } from "vitest";

import {
  isProviderLiveSmokeSuccessful,
  sanitizeProviderOutput,
  summarizeAuthOutput,
  summarizeClaudeLiveOutput,
  summarizeGenericLiveOutput,
  summarizeGeminiLiveOutput,
} from "../src/providers.js";

describe("provider output sanitation", () => {
  it("redacts emails and ids from plain text output", () => {
    const output = sanitizeProviderOutput("logged in as user@example.com org 11111111-1111-4111-8111-111111111111");

    expect(output).toBe("logged in as [redacted-email] org [redacted-id]");
  });

  it("summarizes Claude auth JSON without account identifiers", () => {
    const output = summarizeAuthOutput(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "user@example.com",
        orgId: "11111111-1111-4111-8111-111111111111",
        subscriptionType: "pro",
      }),
    );

    expect(output).toBe("loggedIn=true authMethod=claude.ai apiProvider=firstParty subscriptionType=pro");
  });

  it("recognizes the Gemini JSON live smoke response", () => {
    const output = JSON.stringify({
      response: "OK.",
      model: "gemini-3.1-pro-preview",
      stats: {
        inputTokens: 12,
        outputTokens: 2,
      },
    });

    expect(isProviderLiveSmokeSuccessful("google", output)).toBe(true);
    expect(summarizeGeminiLiveOutput(output)).toBe(
      "response=OK model=gemini-3.1-pro-preview inputTokens=12 outputTokens=2",
    );
  });

  it("recognizes the current Gemini CLI nested live smoke stats", () => {
    const output = JSON.stringify({
      session_id: "11111111-1111-4111-8111-111111111111",
      response: "OK",
      stats: {
        models: {
          "gemini-3.1-pro-preview": {
            tokens: {
              input: 7778,
              candidates: 1,
              total: 7854,
            },
          },
        },
      },
    });

    expect(isProviderLiveSmokeSuccessful("google", output)).toBe(true);
    expect(summarizeGeminiLiveOutput(output)).toBe(
      "response=OK model=gemini-3.1-pro-preview inputTokens=7778 outputTokens=1",
    );
  });

  it("marks unexpected Gemini live smoke output without leaking raw text", () => {
    const output = JSON.stringify({
      response: "hello user@example.com",
      model: "gemini-3.1-pro-preview",
    });

    expect(isProviderLiveSmokeSuccessful("google", output)).toBe(false);
    expect(summarizeGeminiLiveOutput(output)).toBe("response=unexpected model=gemini-3.1-pro-preview");
  });

  it("summarizes Claude live smoke JSON failures", () => {
    const output = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 403,
      result: "Your organization does not have access to Claude. Please login again.",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    });

    expect(isProviderLiveSmokeSuccessful("anthropic", output)).toBe(false);
    expect(summarizeClaudeLiveOutput(output)).toBe(
      "response=unexpected apiError=403 inputTokens=0 outputTokens=0 detail=Your organization does not have access to Claude. Please login again.",
    );
  });

  it("summarizes generic live smoke success without provider logs", () => {
    const output = "some cli header\nOK\ntokens used\n123";

    expect(isProviderLiveSmokeSuccessful("openai", output)).toBe(true);
    expect(summarizeGenericLiveOutput("openai", output)).toBe("response=OK");
  });
});
