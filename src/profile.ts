import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import { MODEL_REGISTRY_FILE, exportModelRegistry, loadModelRegistryForProfile } from "./registry.js";
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
  models?: string[];
  modelReasoningEfforts?: Record<string, string>;
  plannerProvider?: ProviderId;
  plannerModel?: string;
  plannerReasoningEffort?: string;
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

export interface UpdatePlannerProfileModelsOptions {
  root: string;
  models?: string[];
  plannerModel?: string;
}

export interface UpdatePlannerProfilePlannerModelOptions {
  root: string;
  plannerModel: string;
  plannerReasoningEffort?: string;
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
  const availableModels = uniqueStrings(options.models ?? defaultModelIdsForProviders(availableProviders));
  const plannerProvider = options.plannerProvider ?? pickDefaultPlannerProvider(availableProviders);
  const plannerModel = options.plannerModel ?? defaultModelForProvider(plannerProvider, availableModels);
  const modelReasoningEfforts = normalizeModelReasoningEfforts(availableModels, options.modelReasoningEfforts);
  const plannerReasoningEffort =
    options.plannerReasoningEffort ?? modelReasoningEfforts[plannerModel] ?? defaultReasoningEffortForModel(plannerModel);
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
    planner_reasoning_effort: plannerReasoningEffort,
    available_providers: availableProviders,
    available_models: availableModels,
    model_reasoning_efforts: modelReasoningEfforts,
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

  const registryWarnings: string[] = [];

  if (modelRegistrySource === "project") {
    const registryResult = await exportModelRegistry({
      root,
      path: modelRegistry.path,
      force: options.force,
    });

    registryWarnings.push(...registryResult.warnings);
  }

  await writeFile(profilePath, serializePlannerProfile(profile), "utf8");

  return {
    path: profilePath,
    profile,
    written: true,
    warnings: [...validation.warnings, ...registryWarnings],
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

export async function updatePlannerProfileModels(
  options: UpdatePlannerProfileModelsOptions,
): Promise<PlannerProfileWriteResult> {
  const root = path.resolve(options.root);
  const profileResult = await loadPlannerProfile(root);

  if (profileResult.errors.length > 0 || !profileResult.profile) {
    throw new Error(`Profile is not ready.\n${profileResult.errors.join("\n")}`);
  }

  const registryResult = await loadModelRegistryForProfile(root, profileResult.profile);

  if (registryResult.errors.length > 0 || !registryResult.registry) {
    throw new Error(`Model registry is not ready.\n${registryResult.errors.join("\n")}`);
  }

  const registry = registryResult.registry.models;
  const selectedModelIds = uniqueStrings(
    options.models ?? defaultModelIdsForProviders(profileResult.profile.available_providers, registry),
  );

  if (selectedModelIds.length === 0) {
    throw new Error("At least one model must remain in the active model pool.");
  }

  const availableProviders = new Set(profileResult.profile.available_providers);
  const selectedModels = selectedModelIds.map((modelId) => {
    const model = registry.find((entry) => entry.id === modelId);

    if (!model) {
      throw new Error(`Unknown model: ${modelId}. Run blueprint registry show to list known model ids.`);
    }

    if (!availableProviders.has(model.provider)) {
      throw new Error(
        `Model ${modelId} belongs to provider ${model.provider}, which is not in available_providers.`,
      );
    }

    return model;
  });
  const requestedPlannerModel = options.plannerModel
    ? selectedModels.find((model) => model.id === options.plannerModel)
    : undefined;

  if (options.plannerModel && !requestedPlannerModel) {
    throw new Error(`planner_model ${options.plannerModel} is not in the selected model pool.`);
  }

  const currentPlannerModel = selectedModels.find((model) => model.id === profileResult.profile!.planner_model);
  const sameProviderModel = selectedModels.find((model) => model.provider === profileResult.profile!.planner_provider);
  const plannerModel = requestedPlannerModel ?? currentPlannerModel ?? sameProviderModel ?? selectedModels[0]!;
  const modelReasoningEfforts = normalizeModelReasoningEfforts(
    selectedModelIds,
    profileResult.profile.model_reasoning_efforts,
  );
  const profile = PlannerProfileSchema.parse({
    ...profileResult.profile,
    planner_provider: plannerModel.provider,
    planner_model: plannerModel.id,
    planner_reasoning_effort:
      modelReasoningEfforts[plannerModel.id] ?? defaultReasoningEffortForModel(plannerModel.id),
    available_models: selectedModelIds,
    model_reasoning_efforts: modelReasoningEfforts,
  });
  const validation = validatePlannerProfile(profile, getProfilePath(root), registry);

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join("\n"));
  }

  await writeFile(getProfilePath(root), serializePlannerProfile(profile), "utf8");

  return {
    path: getProfilePath(root),
    profile,
    written: true,
    warnings: [...registryResult.warnings, ...validation.warnings],
  };
}

export async function updatePlannerProfilePlannerModel(
  options: UpdatePlannerProfilePlannerModelOptions,
): Promise<PlannerProfileWriteResult> {
  const root = path.resolve(options.root);
  const profileResult = await loadPlannerProfile(root);

  if (profileResult.errors.length > 0 || !profileResult.profile) {
    throw new Error(`Profile is not ready.\n${profileResult.errors.join("\n")}`);
  }

  const registryResult = await loadModelRegistryForProfile(root, profileResult.profile);

  if (registryResult.errors.length > 0 || !registryResult.registry) {
    throw new Error(`Model registry is not ready.\n${registryResult.errors.join("\n")}`);
  }

  const plannerModel = registryResult.registry.models.find((model) => model.id === options.plannerModel);

  if (!plannerModel) {
    throw new Error(`Unknown model: ${options.plannerModel}. Run blueprint registry show to list known model ids.`);
  }

  if (!profileResult.profile.available_providers.includes(plannerModel.provider)) {
    throw new Error(
      `Model ${plannerModel.id} belongs to provider ${plannerModel.provider}, which is not in available_providers.`,
    );
  }

  const availableModels =
    profileResult.profile.available_models.length > 0
      ? uniqueStrings([...profileResult.profile.available_models, plannerModel.id])
      : profileResult.profile.available_models;
  const modelReasoningEfforts = normalizeModelReasoningEfforts(
    availableModels.length > 0 ? availableModels : defaultModelIdsForProviders(profileResult.profile.available_providers, registryResult.registry.models),
    {
      ...profileResult.profile.model_reasoning_efforts,
      ...(options.plannerReasoningEffort ? { [plannerModel.id]: options.plannerReasoningEffort } : {}),
    },
    registryResult.registry.models,
  );
  const profile = PlannerProfileSchema.parse({
    ...profileResult.profile,
    planner_provider: plannerModel.provider,
    planner_model: plannerModel.id,
    planner_reasoning_effort:
      options.plannerReasoningEffort ?? modelReasoningEfforts[plannerModel.id] ?? defaultReasoningEffortForModel(plannerModel.id),
    available_models: availableModels,
    model_reasoning_efforts: modelReasoningEfforts,
  });
  const validation = validatePlannerProfile(profile, getProfilePath(root), registryResult.registry.models);

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join("\n"));
  }

  await writeFile(getProfilePath(root), serializePlannerProfile(profile), "utf8");

  return {
    path: getProfilePath(root),
    profile,
    written: true,
    warnings: [...registryResult.warnings, ...validation.warnings],
  };
}

export function validatePlannerProfile(
  profile: PlannerProfile,
  profilePath = getProfilePath(process.cwd()),
  registry: ModelRegistryEntry[] = DEFAULT_MODEL_REGISTRY,
): PlannerProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const availableProviders = new Set(profile.available_providers);
  const activeModels = activeModelsForProfile(profile, registry);
  const activeModelIds = new Set(activeModels.map((model) => model.id));
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

    if (!activeModels.some((model) => model.provider === provider)) {
      warnings.push(`provider ${provider} has no active model in available_models.`);
    }
  }

  for (const modelId of profile.available_models) {
    const model = registry.find((entry) => entry.id === modelId);

    if (!model) {
      errors.push(`available_model ${modelId} was not found in the active registry.`);
      continue;
    }

    if (!availableProviders.has(model.provider)) {
      errors.push(`available_model ${modelId} belongs to excluded provider ${model.provider}.`);
    }
  }

  if (!selectedModel) {
    errors.push(`planner_model ${profile.planner_model} was not found in the active registry.`);
  } else if (selectedModel.provider !== profile.planner_provider) {
    errors.push(
      `planner_model ${profile.planner_model} belongs to ${selectedModel.provider}, not ${profile.planner_provider}.`,
    );
  } else if (profile.available_models.length > 0 && !activeModelIds.has(profile.planner_model)) {
    errors.push(`planner_model ${profile.planner_model} is not in available_models.`);
  }

  for (const [modelId, effort] of Object.entries(profile.model_reasoning_efforts)) {
    const model = registry.find((entry) => entry.id === modelId);

    if (!model) {
      errors.push(`model_reasoning_efforts.${modelId} was not found in the active registry.`);
      continue;
    }

    if (!activeModelIds.has(modelId)) {
      errors.push(`model_reasoning_efforts.${modelId} is not in the active model pool.`);
    }

    if (model.reasoning_efforts.length > 0 && !model.reasoning_efforts.includes(effort)) {
      errors.push(
        `reasoning effort ${effort} is not available for ${modelId}. Expected one of: ${model.reasoning_efforts.join(", ")}.`,
      );
    }
  }

  if (profile.planner_reasoning_effort && selectedModel) {
    if (
      selectedModel.reasoning_efforts.length > 0
      && !selectedModel.reasoning_efforts.includes(profile.planner_reasoning_effort)
    ) {
      errors.push(
        `planner_reasoning_effort ${profile.planner_reasoning_effort} is not available for ${selectedModel.id}.`,
      );
    }
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

export function parseModelIds(value: string): string[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("At least one model is required.");
  }

  return uniqueStrings(parts);
}

export function activeModelsForProfile(profile: PlannerProfile, registry: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const availableProviders = new Set(profile.available_providers);
  const modelsForAvailableProviders = registry.filter((entry) => availableProviders.has(entry.provider));

  if (profile.available_models.length === 0) {
    return modelsForAvailableProviders;
  }

  const availableModels = new Set(profile.available_models);
  return modelsForAvailableProviders.filter((entry) => availableModels.has(entry.id));
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

function defaultModelForProvider(provider: ProviderId, availableModels?: string[]): string {
  const activeIds = availableModels ? new Set(availableModels) : undefined;
  const model = DEFAULT_MODEL_REGISTRY.find(
    (entry) => entry.provider === provider && (!activeIds || activeIds.has(entry.id)),
  );

  if (!model) {
    throw new Error(`No default model is registered for provider ${provider}.`);
  }

  return model.id;
}

function normalizeModelReasoningEfforts(
  modelIds: string[],
  selected: Record<string, string> = {},
  registry: ModelRegistryEntry[] = DEFAULT_MODEL_REGISTRY,
): Record<string, string> {
  const selectedIds = new Set(modelIds);
  const efforts: Record<string, string> = {};

  for (const model of registry) {
    if (!selectedIds.has(model.id) || model.reasoning_efforts.length === 0) {
      continue;
    }

    efforts[model.id] = selected[model.id] ?? model.default_reasoning_effort ?? model.reasoning_efforts[0]!;
  }

  return efforts;
}

function defaultReasoningEffortForModel(
  modelId: string,
  registry: ModelRegistryEntry[] = DEFAULT_MODEL_REGISTRY,
): string | undefined {
  const model = registry.find((entry) => entry.id === modelId);

  return model?.default_reasoning_effort ?? model?.reasoning_efforts[0];
}

export function defaultModelIdsForProviders(
  providers: ProviderId[],
  registry: ModelRegistryEntry[] = DEFAULT_MODEL_REGISTRY,
): string[] {
  const availableProviders = new Set(providers);
  return registry.filter(
    (entry) => availableProviders.has(entry.provider) && entry.status !== "restricted",
  ).map((entry) => entry.id);
}

function uniqueProviders(providers: ProviderId[]): ProviderId[] {
  return [...new Set(providers)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
