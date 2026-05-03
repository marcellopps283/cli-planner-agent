import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import { MODEL_REGISTRY_FILE, loadModelRegistryForProfile } from "./registry.js";
import {
  PlannerProfileSchema,
  ProviderIdSchema,
  type ModelRegistryEntry,
  type PlannerProfile,
  type ProviderId,
} from "./schemas.js";

export const PROFILE_FILE = "profile.yaml";
const KNOWN_PROVIDER_IDS = ProviderIdSchema.options;

export interface InitPlannerProfileOptions {
  root: string;
  name?: string;
  providers?: ProviderId[];
  plannerProvider?: ProviderId;
  plannerModel?: string;
  modelRegistrySource?: "bundled" | "project";
  modelRegistryPath?: string;
  force?: boolean;
  notes?: string[];
}

export interface PlannerProfileWriteResult {
  path: string;
  profile: PlannerProfile;
  written: boolean;
  warnings: string[];
}

export interface PlannerProfileValidationResult {
  path: string;
  profile?: PlannerProfile;
  errors: string[];
  warnings: string[];
}

export async function initPlannerProfile(
  options: InitPlannerProfileOptions,
): Promise<PlannerProfileWriteResult> {
  const root = path.resolve(options.root);
  const profilePath = getProfilePath(root);
  const availableProviders = uniqueProviders(options.providers ?? KNOWN_PROVIDER_IDS);
  const plannerProvider = options.plannerProvider ?? pickDefaultPlannerProvider(availableProviders);
  const plannerModel = options.plannerModel ?? defaultModelForProvider(plannerProvider);
  const modelRegistrySource = options.modelRegistrySource ?? "bundled";
  const modelRegistry =
    modelRegistrySource === "project"
      ? { source: "project" as const, path: options.modelRegistryPath ?? MODEL_REGISTRY_FILE }
      : { source: "bundled" as const };

  const profile = PlannerProfileSchema.parse({
    schema_version: "1.0",
    name: options.name ?? "default",
    planner_provider: plannerProvider,
    planner_model: plannerModel,
    available_providers: availableProviders,
    excluded_providers: KNOWN_PROVIDER_IDS.filter((provider) => !availableProviders.includes(provider)),
    model_registry: modelRegistry,
    routing: {
      prefer_available_only: true,
      allow_provider_fallback: true,
      require_confirmation_for_fallback: true,
    },
    live_checks: {
      require_before_plan: false,
    },
    notes: options.notes ?? [],
  });

  const validation = validatePlannerProfile(profile);

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join("\n"));
  }

  if (!options.force) {
    try {
      await readFile(profilePath, "utf8");
      return {
        path: profilePath,
        profile,
        written: false,
        warnings: ["profile.yaml already exists. Use --force to overwrite it."],
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, serializePlannerProfile(profile), "utf8");

  return {
    path: profilePath,
    profile,
    written: true,
    warnings: validation.warnings,
  };
}

export async function loadPlannerProfile(rootInput: string): Promise<PlannerProfileValidationResult> {
  const root = path.resolve(rootInput);
  const profilePath = getProfilePath(root);

  try {
    const raw = await readFile(profilePath, "utf8");
    const parsed = PlannerProfileSchema.safeParse(parseYaml(raw));

    if (!parsed.success) {
      return {
        path: profilePath,
        errors: [formatValidationError("profile.yaml", parsed.error)],
        warnings: [],
      };
    }

    const registryResult = await loadModelRegistryForProfile(root, parsed.data);
    const result = validatePlannerProfile(parsed.data, profilePath, registryResult.registry?.models);

    return {
      ...result,
      errors: [...registryResult.errors, ...result.errors],
      warnings: [...registryResult.warnings, ...result.warnings],
    };
  } catch (error) {
    return {
      path: profilePath,
      errors: [formatValidationError("profile.yaml", error)],
      warnings: [],
    };
  }
}

export function validatePlannerProfile(
  profile: PlannerProfile,
  profilePath = getProfilePath(process.cwd()),
  registry: ModelRegistryEntry[] = DEFAULT_MODEL_REGISTRY,
): PlannerProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const availableProviders = new Set(profile.available_providers);
  const excludedProviders = new Set(profile.excluded_providers);
  const selectedModel = registry.find((model) => model.id === profile.planner_model);

  if (!availableProviders.has(profile.planner_provider)) {
    errors.push(`planner_provider ${profile.planner_provider} is not in available_providers.`);
  }

  for (const provider of profile.available_providers) {
    if (excludedProviders.has(provider)) {
      errors.push(`provider ${provider} cannot be both available and excluded.`);
    }

    if (!registry.some((model) => model.provider === provider)) {
      warnings.push(`provider ${provider} has no model in the active registry.`);
    }
  }

  if (!selectedModel) {
    errors.push(`planner_model ${profile.planner_model} was not found in the active registry.`);
  } else if (selectedModel.provider !== profile.planner_provider) {
    errors.push(
      `planner_model ${profile.planner_model} belongs to ${selectedModel.provider}, not ${profile.planner_provider}.`,
    );
  }

  if (profile.model_registry.source === "project" && !profile.model_registry.path) {
    errors.push("model_registry.path is required when model_registry.source is project.");
  }

  return {
    path: profilePath,
    profile,
    errors,
    warnings,
  };
}

export function parseProviderIds(value: string): ProviderId[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("At least one provider is required.");
  }

  return uniqueProviders(
    parts.map((part) => {
      const parsed = ProviderIdSchema.safeParse(part);

      if (!parsed.success) {
        throw new Error(`Unknown provider: ${part}. Expected one of: ${KNOWN_PROVIDER_IDS.join(", ")}.`);
      }

      return parsed.data;
    }),
  );
}

export function serializePlannerProfile(profile: PlannerProfile): string {
  return stringify(profile);
}

export function getProfilePath(root: string): string {
  return path.join(path.resolve(root), BLUEPRINT_DIR, PROFILE_FILE);
}

function pickDefaultPlannerProvider(providers: ProviderId[]): ProviderId {
  if (providers.includes("anthropic")) {
    return "anthropic";
  }

  if (providers.includes("openai")) {
    return "openai";
  }

  return providers[0] ?? "google";
}

function defaultModelForProvider(provider: ProviderId): string {
  const model = DEFAULT_MODEL_REGISTRY.find((entry) => entry.provider === provider);

  if (!model) {
    throw new Error(`No default model is registered for provider ${provider}.`);
  }

  return model.id;
}

function uniqueProviders(providers: ProviderId[]): ProviderId[] {
  return [...new Set(providers)];
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
