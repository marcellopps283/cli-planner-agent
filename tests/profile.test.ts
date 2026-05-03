import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initPlannerProfile, loadPlannerProfile, parseProviderIds, validatePlannerProfile } from "../src/profile.js";

describe("planner profiles", () => {
  it("writes and validates a local OpenAI/Gemini profile", async () => {
    const root = await makeTempProject();
    const result = await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });

    const raw = await readFile(path.join(root, ".blueprint", "profile.yaml"), "utf8");
    const loaded = await loadPlannerProfile(root);

    expect(result.written).toBe(true);
    expect(raw).toContain("planner_provider: openai");
    expect(loaded.errors).toEqual([]);
    expect(loaded.profile?.available_providers).toEqual(["openai", "google"]);
    expect(loaded.profile?.excluded_providers).toEqual(["anthropic"]);
  });

  it("creates the project registry when the profile points at it", async () => {
    const root = await makeTempProject();
    const result = await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
      modelRegistrySource: "project",
    });

    const rawRegistry = await readFile(path.join(root, ".blueprint", "model_registry.yaml"), "utf8");
    const loaded = await loadPlannerProfile(root);

    expect(result.written).toBe(true);
    expect(rawRegistry).toContain("gemini-3.1-pro-preview");
    expect(loaded.errors).toEqual([]);
    expect(loaded.profile?.model_registry).toEqual({
      source: "project",
      path: "model_registry.yaml",
    });
  });

  it("rejects planner providers outside the active pool", async () => {
    const profile = {
      schema_version: "1.0" as const,
      name: "default",
      planner_provider: "anthropic" as const,
      planner_model: "claude-opus-4-7",
      available_providers: ["openai" as const, "google" as const],
      available_models: ["gpt-5.5", "gemini-3.1-pro-preview"],
      excluded_providers: ["anthropic" as const],
      model_registry: {
        source: "bundled" as const,
      },
      routing: {
        prefer_available_only: true as const,
        allow_provider_fallback: true,
        require_confirmation_for_fallback: true,
      },
      live_checks: {
        require_before_plan: false,
      },
      notes: [],
    };

    const result = validatePlannerProfile(profile);

    expect(result.errors).toContain("planner_provider anthropic is not in available_providers.");
  });

  it("parses comma-separated provider ids with dedupe", () => {
    expect(parseProviderIds("openai, google, openai")).toEqual(["openai", "google"]);
    expect(() => parseProviderIds("openai,unknown")).toThrow("Unknown provider: unknown");
  });
});

async function makeTempProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "blueprint-profile-test-"));
}
