import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { exportModelRegistry, getRegistryPath, loadModelRegistryFile, validateModelRegistry } from "../src/registry.js";

describe("model registry", () => {
  it("exports and validates the bundled registry", async () => {
    const root = await makeTempProject();
    const exported = await exportModelRegistry({ root });
    const loaded = await loadModelRegistryFile(getRegistryPath(root));

    expect(exported.written).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.registry?.models.map((model) => model.id)).toContain("openai-codex-default");
  });

  it("rejects duplicate model ids", () => {
    const result = validateModelRegistry({
      schema_version: "1.0",
      models: [
        {
          id: "duplicate",
          provider: "openai",
          access_mode: "codex_cli",
          task_fit: {
            planning: 0.5,
          },
          strengths: [],
          weaknesses: [],
          latency_class: "unknown",
          cost_class: "unknown",
          privacy_notes: "",
          recommended_uses: ["test"],
          avoid_for: ["test"],
        },
        {
          id: "duplicate",
          provider: "google",
          access_mode: "gemini_cli",
          task_fit: {
            planning: 0.5,
          },
          strengths: [],
          weaknesses: [],
          latency_class: "unknown",
          cost_class: "unknown",
          privacy_notes: "",
          recommended_uses: ["test"],
          avoid_for: ["test"],
        },
      ],
    });

    expect(result.errors).toContain("duplicate model id duplicate.");
  });

  it("loads project registry files from yaml", async () => {
    const root = await makeTempProject();
    const registryPath = path.join(root, "model_registry.yaml");
    await writeFile(
      registryPath,
      stringify({
        schema_version: "1.0",
        models: [
          {
            id: "custom-openai",
            provider: "openai",
            access_mode: "codex_cli",
            task_fit: {
              planning: 0.8,
            },
            recommended_uses: ["planning"],
            avoid_for: ["quota constrained sessions"],
          },
        ],
      }),
      "utf8",
    );

    const result = await loadModelRegistryFile(registryPath);

    expect(result.errors).toEqual([]);
    expect(result.registry?.models[0]?.id).toBe("custom-openai");
  });
});

async function makeTempProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "blueprint-registry-test-"));
}
