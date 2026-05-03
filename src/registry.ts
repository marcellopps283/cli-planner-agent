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

export interface ModelRegistryValidationResult {
  path: string;
  registry?: ModelRegistryFile;
  errors: string[];
  warnings: string[];
}

export interface ExportModelRegistryOptions {
  root: string;
  force?: boolean;
}

export async function exportModelRegistry(options: ExportModelRegistryOptions): Promise<{
  path: string;
  registry: ModelRegistryFile;
  written: boolean;
  warnings: string[];
}> {
  const root = path.resolve(options.root);
  const registryPath = getRegistryPath(root);
  const registry: ModelRegistryFile = {
    schema_version: "1.0",
    models: DEFAULT_MODEL_REGISTRY,
  };
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
    const registry: ModelRegistryFile = {
      schema_version: "1.0",
      models: DEFAULT_MODEL_REGISTRY,
    };

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

export function serializeModelRegistry(registry: ModelRegistryFile): string {
  return stringify(registry);
}

export function getRegistryPath(root: string): string {
  return path.join(path.resolve(root), BLUEPRINT_DIR, MODEL_REGISTRY_FILE);
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
