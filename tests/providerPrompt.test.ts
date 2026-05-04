import { describe, expect, it } from "vitest";

import { extractJsonObject, providerPromptModelArgs } from "../src/providerPrompt.js";

describe("provider prompt parsing", () => {
  it("extracts raw JSON responses", () => {
    expect(extractJsonObject('{"ok":true}')).toBe('{"ok":true}');
  });

  it("extracts fenced JSON responses", () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it("extracts embedded JSON responses", () => {
    expect(extractJsonObject('Here is the result:\n{"ok":true}\nDone.')).toBe('{"ok":true}');
  });

  it("rejects responses without JSON", () => {
    expect(() => extractJsonObject("not json")).toThrow("Provider response did not contain a JSON object.");
  });

  it("passes exact model ids using each official CLI flag shape", () => {
    expect(providerPromptModelArgs("openai", "gpt-5.5")).toEqual(["-m", "gpt-5.5"]);
    expect(providerPromptModelArgs("google", "gemini-3.1-pro-preview")).toEqual([
      "-m",
      "gemini-3.1-pro-preview",
    ]);
    expect(providerPromptModelArgs("anthropic", "claude-opus-4-7")).toEqual([
      "--model",
      "claude-opus-4-7",
    ]);
    expect(providerPromptModelArgs("openai")).toEqual([]);
  });
});
