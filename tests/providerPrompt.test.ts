import { describe, expect, it } from "vitest";

import { extractJsonObject } from "../src/providerPrompt.js";

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
});
