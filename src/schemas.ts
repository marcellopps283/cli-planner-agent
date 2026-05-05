import { z } from "zod";

export const ProviderIdSchema = z.enum(["openai", "anthropic", "google"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderAdapterSchema = z.object({
  id: ProviderIdSchema,
  cli: z.string().min(1),
  enabled: z.boolean(),
  authStatusCommand: z.array(z.string()).min(1).optional(),
  liveCheckCommand: z.array(z.string()).min(1).optional(),
  nonInteractiveCommand: z.array(z.string()).min(1).optional(),
});

export type ProviderAdapter = z.infer<typeof ProviderAdapterSchema>;

export const ModelRegistryEntrySchema = z.object({
  id: z.string().min(1),
  provider: ProviderIdSchema,
  access_mode: z.string().min(1),
  status: z.enum(["stable", "preview", "restricted"]).default("stable"),
  tier: z.enum(["frontier", "balanced", "utility", "specialized"]).default("balanced"),
  release_date: z.iso.date().optional(),
  task_fit: z.record(z.string(), z.number().min(0).max(1)),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  input_price_usd_per_mtok: z.number().nonnegative().optional(),
  output_price_usd_per_mtok: z.number().nonnegative().optional(),
  reasoning_efforts: z.array(z.string().min(1)).default([]),
  default_reasoning_effort: z.string().min(1).optional(),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  latency_class: z.enum(["low", "medium", "high", "unknown"]).default("unknown"),
  cost_class: z.enum(["free", "subscription", "api_paid", "unknown"]).default("unknown"),
  privacy_notes: z.string().default(""),
  routing_tags: z.array(z.string()).default([]),
  benchmark_scores: z
    .array(
      z.object({
        name: z.string().min(1),
        score: z.string().min(1),
        mode: z.string().optional(),
        source: z.string().min(1),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  recommended_uses: z.array(z.string()).default([]),
  avoid_for: z.array(z.string()).default([]),
  source_urls: z.array(z.string().url()).default([]),
});

export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntrySchema>;

export const ModelRegistryMetadataSchema = z
  .object({
    generated_at: z.iso.datetime().optional(),
    source: z.enum(["bundled", "project_refresh", "custom"]).default("custom"),
    bundled_revision: z.string().min(1).optional(),
    research_verified_at: z.iso.date().optional(),
    source_urls: z.array(z.string().url()).default([]),
  })
  .default({
    source: "custom",
    source_urls: [],
  });

export type ModelRegistryMetadata = z.infer<typeof ModelRegistryMetadataSchema>;

export const ModelRegistryFileSchema = z.object({
  schema_version: z.literal("1.0"),
  metadata: ModelRegistryMetadataSchema,
  models: z.array(ModelRegistryEntrySchema).min(1),
});

export type ModelRegistryFile = z.infer<typeof ModelRegistryFileSchema>;

export const PlannerProfileSchema = z.object({
  schema_version: z.literal("1.0"),
  name: z.string().min(1).default("default"),
  planner_provider: ProviderIdSchema,
  planner_model: z.string().min(1),
  planner_reasoning_effort: z.string().min(1).optional(),
  available_providers: z.array(ProviderIdSchema).min(1),
  available_models: z.array(z.string().min(1)).default([]),
  model_reasoning_efforts: z.record(z.string(), z.string().min(1)).default({}),
  excluded_providers: z.array(ProviderIdSchema).default([]),
  model_registry: z
    .object({
      source: z.enum(["bundled", "project"]).default("bundled"),
      path: z.string().min(1).optional(),
    })
    .default({ source: "bundled" }),
  routing: z
    .object({
      prefer_available_only: z.literal(true).default(true),
      allow_provider_fallback: z.boolean().default(true),
      require_confirmation_for_fallback: z.boolean().default(true),
    })
    .default({
      prefer_available_only: true,
      allow_provider_fallback: true,
      require_confirmation_for_fallback: true,
    }),
  live_checks: z
    .object({
      require_before_plan: z.boolean().default(false),
      last_verified_at: z.iso.datetime().optional(),
    })
    .default({ require_before_plan: false }),
  notes: z.array(z.string()).default([]),
});

export type PlannerProfile = z.infer<typeof PlannerProfileSchema>;

export const BlueprintManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  project_name: z.string().min(1),
  created_at: z.iso.datetime(),
  planner_provider: ProviderIdSchema.optional(),
  planner_model: z.string().min(1).optional(),
  available_providers: z.array(ProviderIdSchema).default([]),
  available_models: z.array(z.string().min(1)).default([]),
  artifact_root: z.literal(".blueprint"),
  status: z.enum(["draft", "planned", "revised"]).default("draft"),
});

export type BlueprintManifest = z.infer<typeof BlueprintManifestSchema>;

export const BlueprintTaskMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  suggested_model: z.string().min(1),
  model_rationale: z.string().min(1).optional(),
  acceptable_alternatives: z.array(z.string().min(1)).optional(),
  dependencies: z.array(z.string()).default([]),
  parallel_group: z.string().optional(),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  risk_level: z.number().int().min(1).max(10),
  test_commands: z.array(z.string()).default([]),
});

export type BlueprintTaskMetadata = z.infer<typeof BlueprintTaskMetadataSchema>;

export const DependencyGraphSchema = z.object({
  schema_version: z.literal("1.0"),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      task_file: z.string().min(1),
      depends_on: z.array(z.string()).default([]),
      allowed_paths: z.array(z.string()).default([]),
      risk_level: z.number().int().min(1).max(10),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  parallel_groups: z.record(z.string(), z.array(z.string())).default({}),
});

export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;
