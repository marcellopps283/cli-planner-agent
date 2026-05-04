import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import {
  ModelRegistryFileSchema,
  type ModelRegistryEntry,
  type ModelRegistryFile,
  type PlannerProfile,
} from "./schemas.js";

export const MODEL_REGISTRY_FILE = "model_registry.yaml";
export const BUNDLED_MODEL_REGISTRY_REVISION = "2026-05-03-gpt55-opus47-gemini31";
export const BUNDLED_MODEL_REGISTRY_RESEARCH_DATE = "2026-05-03";
const MODEL_REGISTRY_SOURCE_URLS = [
  "https://developers.openai.com/api/docs/models",
  "https://openai.com/index/introducing-gpt-5-5/",
  "https://platform.claude.com/docs/en/about-claude/models/overview",
  "https://www.anthropic.com/news/claude-opus-4-7",
  "https://ai.google.dev/gemini-api/docs/models",
  "https://deepmind.google/models/model-cards/gemini-3-1-pro/",
];

export interface ModelRegistryValidationResult {
  path: string;
  registry?: ModelRegistryFile;
  errors: string[];
  warnings: string[];
}

export interface ExportModelRegistryOptions {
  root: string;
  path?: string;
  force?: boolean;
}

export interface RefreshModelRegistryOptions {
  root: string;
  path?: string;
  dryRun?: boolean;
}

export interface RefreshModelRegistryResult {
  path: string;
  registry: ModelRegistryFile;
  written: boolean;
  created: boolean;
  added: string[];
  updated: string[];
  preserved_custom: string[];
  warnings: string[];
}

export async function exportModelRegistry(options: ExportModelRegistryOptions): Promise<{
  path: string;
  registry: ModelRegistryFile;
  written: boolean;
  warnings: string[];
}> {
  const root = path.resolve(options.root);
  const registryPath = resolveRegistryPath(root, options.path ?? MODEL_REGISTRY_FILE);
  const registry = createBundledRegistryFile("bundled");
  const validation = validateModelRegistry(registry, registryPath);

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join("\n"));
  }

  if (!options.force) {
    try {
      await readFile(registryPath, "utf8");
      return {
        path: registryPath,
        registry,
        written: false,
        warnings: [`${MODEL_REGISTRY_FILE} already exists. Use --force to overwrite it.`],
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, serializeModelRegistry(registry), "utf8");

  return {
    path: registryPath,
    registry,
    written: true,
    warnings: validation.warnings,
  };
}

export async function refreshModelRegistry(options: RefreshModelRegistryOptions): Promise<RefreshModelRegistryResult> {
  const root = path.resolve(options.root);
  const registryPath = resolveRegistryPath(root, options.path ?? MODEL_REGISTRY_FILE);
  const existing = await loadExistingRegistryForRefresh(registryPath);
  const bundled = createBundledRegistryFile("project_refresh");
  const existingModelsById = new Map(existing.registry?.models.map((model) => [model.id, model]) ?? []);
  const bundledModelsById = new Map(bundled.models.map((model) => [model.id, model]));
  const customModels = (existing.registry?.models ?? []).filter((model) => !bundledModelsById.has(model.id));
  const added = bundled.models.filter((model) => !existingModelsById.has(model.id)).map((model) => model.id);
  const updated = bundled.models
    .filter((model) => {
      const existingModel = existingModelsById.get(model.id);
      return existingModel ? JSON.stringify(existingModel) !== JSON.stringify(model) : false;
    })
    .map((model) => model.id);
  const registry: ModelRegistryFile = {
    ...bundled,
    models: [...bundled.models, ...customModels],
  };
  const validation = validateModelRegistry(registry, registryPath);

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join("\n"));
  }

  if (!options.dryRun) {
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, serializeModelRegistry(registry), "utf8");
  }

  return {
    path: registryPath,
    registry,
    written: !options.dryRun,
    created: !existing.registry,
    added,
    updated,
    preserved_custom: customModels.map((model) => model.id),
    warnings: [...existing.warnings, ...validation.warnings],
  };
}

export async function loadModelRegistryFile(registryPath: string): Promise<ModelRegistryValidationResult> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = ModelRegistryFileSchema.safeParse(parseYaml(raw));

    if (!parsed.success) {
      return {
        path: registryPath,
        errors: [formatValidationError(MODEL_REGISTRY_FILE, parsed.error)],
        warnings: [],
      };
    }

    return validateModelRegistry(parsed.data, registryPath);
  } catch (error) {
    return {
      path: registryPath,
      errors: [formatValidationError(MODEL_REGISTRY_FILE, error)],
      warnings: [],
    };
  }
}

export async function loadModelRegistryForProfile(
  rootInput: string,
  profile: PlannerProfile,
): Promise<ModelRegistryValidationResult> {
  const root = path.resolve(rootInput);

  if (profile.model_registry.source === "bundled") {
    const registry = createBundledRegistryFile("bundled");

    return validateModelRegistry(registry, "bundled");
  }

  const registryPath = resolveRegistryPath(root, profile.model_registry.path ?? MODEL_REGISTRY_FILE);
  return loadModelRegistryFile(registryPath);
}

export function validateModelRegistry(
  registry: ModelRegistryFile,
  registryPath = "bundled",
): ModelRegistryValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  for (const model of registry.models) {
    if (seenIds.has(model.id)) {
      errors.push(`duplicate model id ${model.id}.`);
    }

    seenIds.add(model.id);

    if (model.recommended_uses.length === 0) {
      warnings.push(`model ${model.id} has no recommended_uses.`);
    }

    if (model.avoid_for.length === 0) {
      warnings.push(`model ${model.id} has no avoid_for guidance.`);
    }
  }

  return {
    path: registryPath,
    registry,
    errors,
    warnings,
  };
}

export function createBundledRegistryFile(source: "bundled" | "project_refresh" = "bundled"): ModelRegistryFile {
  return {
    schema_version: "1.0",
    metadata: {
      generated_at: new Date().toISOString(),
      source,
      bundled_revision: BUNDLED_MODEL_REGISTRY_REVISION,
      research_verified_at: BUNDLED_MODEL_REGISTRY_RESEARCH_DATE,
      source_urls: MODEL_REGISTRY_SOURCE_URLS,
    },
    models: DEFAULT_MODEL_REGISTRY,
  };
}

export function serializeModelRegistry(registry: ModelRegistryFile): string {
  return stringify(registry);
}

async function loadExistingRegistryForRefresh(
  registryPath: string,
): Promise<{ registry?: ModelRegistryFile; warnings: string[] }> {
  try {
    await readFile(registryPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        warnings: [],
      };
    }

    throw error;
  }

  const existing = await loadModelRegistryFile(registryPath);

  if (existing.errors.length > 0 || !existing.registry) {
    throw new Error(existing.errors.join("\n"));
  }

  return {
    registry: existing.registry,
    warnings: existing.warnings,
  };
}

export function getRegistryPath(root: string): string {
  return resolveRegistryPath(root, MODEL_REGISTRY_FILE);
}

export function resolveRegistryPath(root: string, registryPath: string): string {
  if (path.isAbsolute(registryPath)) {
    return registryPath;
  }

  return path.join(path.resolve(root), BLUEPRINT_DIR, registryPath);
}

function formatValidationError(scope: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    return `${scope}: ${z.prettifyError(error)}`;
  }

  if (error instanceof Error) {
    return `${scope}: ${error.message}`;
  }

  return `${scope}: ${String(error)}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
