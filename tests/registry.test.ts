import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  exportModelRegistry,
  getRegistryPath,
  loadModelRegistryFile,
  refreshModelRegistry,
  validateModelRegistry,
} from "../src/registry.js";

describe("model registry", () => {
  it("exports and validates the bundled registry", async () => {
    const root = await makeTempProject();
    const exported = await exportModelRegistry({ root });
    const loaded = await loadModelRegistryFile(getRegistryPath(root));

    expect(exported.written).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.registry?.models.map((model) => model.id)).toContain("gpt-5.5");
  });

  it("rejects duplicate model ids", () => {
    const result = validateModelRegistry({
      schema_version: "1.0",
      metadata: {
        source: "custom",
        source_urls: [],
      },
      models: [
        {
          id: "duplicate",
          provider: "openai",
          access_mode: "codex_cli",
          status: "stable",
          tier: "utility",
          task_fit: {
            planning: 0.5,
          },
          strengths: [],
          weaknesses: [],
          latency_class: "unknown",
          cost_class: "unknown",
          privacy_notes: "",
          routing_tags: [],
          benchmark_scores: [],
          recommended_uses: ["test"],
          avoid_for: ["test"],
          source_urls: [],
        },
        {
          id: "duplicate",
          provider: "google",
          access_mode: "gemini_cli",
          status: "stable",
          tier: "utility",
          task_fit: {
            planning: 0.5,
          },
          strengths: [],
          weaknesses: [],
          latency_class: "unknown",
          cost_class: "unknown",
          privacy_notes: "",
          routing_tags: [],
          benchmark_scores: [],
          recommended_uses: ["test"],
          avoid_for: ["test"],
          source_urls: [],
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

  it("refreshes the project registry and preserves custom models", async () => {
    const root = await makeTempProject();
    await exportModelRegistry({ root });
    const registryPath = getRegistryPath(root);
    const loaded = await loadModelRegistryFile(registryPath);
    const staleRegistry = {
      ...loaded.registry!,
      models: [
        {
          ...loaded.registry!.models[0]!,
          strengths: ["stale local override"],
        },
        {
          id: "custom-local-model",
          provider: "openai" as const,
          access_mode: "codex_cli",
          task_fit: {
            planning: 0.5,
          },
          recommended_uses: ["local testing"],
          avoid_for: ["production plans"],
        },
      ],
    };

    await writeFile(registryPath, stringify(staleRegistry), "utf8");

    const result = await refreshModelRegistry({ root });
    const refreshed = await loadModelRegistryFile(registryPath);

    expect(result.written).toBe(true);
    expect(result.updated).toContain(loaded.registry!.models[0]!.id);
    expect(result.preserved_custom).toEqual(["custom-local-model"]);
    expect(refreshed.errors).toEqual([]);
    expect(refreshed.registry?.models.map((model) => model.id)).toContain("custom-local-model");
    expect(refreshed.registry?.metadata.source).toBe("project_refresh");
  });
});

async function makeTempProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "blueprint-registry-test-"));
}
