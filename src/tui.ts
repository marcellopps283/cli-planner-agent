import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import { Box, Text, render, renderToString, useApp, useInput } from "ink";
import React, { createElement, useState } from "react";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR, initBlueprint } from "./blueprint.js";
import { inspectProject, type ProjectDoctorReport } from "./doctor.js";
import { exportBlueprint, type ExportBlueprintResult } from "./export.js";
import { lintBlueprint, type BlueprintLintResult } from "./lint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import { generateBlueprintPlan, previewBlueprintPlan, type PlanAnswers, type PlanEngine } from "./plan.js";
import {
  initPlannerProfile,
  loadPlannerProfile,
  parseModelIds,
  updatePlannerProfileModels,
  type PlannerProfileValidationResult,
} from "./profile.js";
import { DEFAULT_PROVIDER_ADAPTERS, checkProvider, checkProviderAuth, type ProviderDoctorResult } from "./providers.js";
import { exportModelRegistry, loadModelRegistryForProfile, refreshModelRegistry } from "./registry.js";
import { reviseBlueprint, type ReviseResult } from "./revise.js";
import {
  BlueprintManifestSchema,
  BlueprintTaskMetadataSchema,
  DependencyGraphSchema,
  type BlueprintManifest,
  type BlueprintTaskMetadata,
  type DependencyGraph,
  type ModelRegistryEntry,
  type PlannerProfile,
  type ProviderId,
} from "./schemas.js";

export interface TuiDashboardOptions {
  root: string;
  initialView?: TuiView;
}

export interface TuiTaskSummary {
  id: string;
  title: string;
  suggestedModel: string;
  dependencies: string[];
  allowedPaths: string[];
  riskLevel: number;
}

export interface TuiModelSummary {
  id: string;
  provider: ProviderId;
  tier: string;
  status: string;
}

export interface TuiSetupStatus {
  initialized: boolean;
  messages: string[];
  commands: string[];
}

export interface TuiDashboard {
  root: string;
  setup: TuiSetupStatus;
  profile: PlannerProfileValidationResult;
  doctor: ProjectDoctorReport;
  lint: BlueprintLintResult;
  manifest?: BlueprintManifest;
  graph?: DependencyGraph;
  tasks: TuiTaskSummary[];
  registryModels: TuiModelSummary[];
  exports: string[];
  tuiSessions: string[];
  nextAction: string;
}

export const TUI_ACTION_IDS = [
  "setup",
  "plan",
  "model-pool",
  "registry-refresh",
  "lint",
  "export",
  "revise",
  "auth-doctor",
  "auth-doctor-live",
] as const;
export type TuiActionId = (typeof TUI_ACTION_IDS)[number];

type SetupStep = "idle" | "providers" | "models" | "planner" | "confirm";

interface SetupDraft {
  providers: ProviderId[];
  models: string[];
  plannerModel?: string;
}

type PlanChatStep =
  | "idle"
  | "projectSummary"
  | "objective"
  | "successCriteria"
  | "constraints"
  | "outOfScope"
  | "targetPaths"
  | "validationCommands"
  | "riskLevel"
  | "notes";

interface PlanChatDraft {
  projectSummary?: string;
  objective?: string;
  successCriteria?: string[];
  constraints?: string[];
  outOfScope?: string[];
  targetPaths?: string[];
  validationCommands?: string[];
  riskLevel?: number;
  notes?: string[];
}

const SETUP_PROVIDER_OPTIONS = ["openai", "anthropic", "google"] as const satisfies readonly ProviderId[];
const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI / Codex",
  anthropic: "Anthropic / Claude Code",
  google: "Google / Gemini",
};

const PLAN_CHAT_STEPS = [
  "projectSummary",
  "objective",
  "successCriteria",
  "constraints",
  "outOfScope",
  "targetPaths",
  "validationCommands",
  "riskLevel",
  "notes",
] as const satisfies readonly Exclude<PlanChatStep, "idle">[];

const PLAN_STEP_PROMPTS: Record<Exclude<PlanChatStep, "idle">, string> = {
  projectSummary: "Resumo do projeto em uma frase",
  objective: "Qual entrega voce quer planejar agora",
  successCriteria: "Criterios de sucesso, separados por virgula",
  constraints: "Restricoes tecnicas ou de negocio, separadas por virgula; vazio para none",
  outOfScope: "Fora de escopo, separado por virgula; vazio para none",
  targetPaths: "Paths provaveis, separados por virgula; vazio para inferir",
  validationCommands: "Comandos de validacao, separados por virgula; vazio para manual",
  riskLevel: "Risco geral de 1 a 10",
  notes: "Observacoes adicionais para os workers; vazio para none",
};

export interface TuiAction {
  id: TuiActionId;
  label: string;
  command: string;
  description: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  requiresInput?: boolean;
}

export interface TuiActionResult {
  actionId: TuiActionId;
  status: "ok" | "failed";
  summary: string;
  lines: string[];
  canApply?: boolean;
  change?: string;
  sessionPath?: string;
}

export interface RunTuiActionOptions {
  root: string;
  actionId: TuiActionId;
  change?: string;
  modelPool?: string;
  planAnswers?: PlanAnswers;
  planEngine?: PlanEngine;
  planForce?: boolean;
  providers?: ProviderId[];
  models?: string[];
  plannerProvider?: ProviderId;
  plannerModel?: string;
  apply?: boolean;
  liveTimeoutMs?: number;
  providerChecker?: (live: boolean) => Promise<ProviderDoctorResult[]>;
  recordHistory?: boolean;
}

export const TuiSessionRecordSchema = z.object({
  schema_version: z.literal("1.0"),
  session_id: z.string().min(1),
  created_at: z.iso.datetime(),
  root: z.string().min(1),
  action: z.object({
    id: z.enum(TUI_ACTION_IDS),
    command: z.string().min(1),
    change: z.string().min(1).optional(),
    apply: z.boolean().default(false),
  }),
  result: z.object({
    status: z.enum(["ok", "failed"]),
    summary: z.string().min(1),
    lines: z.array(z.string()),
    can_apply: z.boolean().optional(),
  }),
});

export type TuiSessionRecord = z.infer<typeof TuiSessionRecordSchema>;

export const TUI_VIEWS = ["overview", "tasks", "graph", "providers", "actions"] as const;
export type TuiView = (typeof TUI_VIEWS)[number];

const h = createElement;

export async function loadTuiDashboard(options: TuiDashboardOptions): Promise<TuiDashboard> {
  const root = path.resolve(options.root);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  const [setup, profile, doctor, lint, manifest, graph, tasks, exports, tuiSessions] = await Promise.all([
    inspectBlueprintSetup(root, blueprintRoot),
    loadPlannerProfile(root),
    inspectProject(root),
    lintBlueprint(root),
    readManifest(blueprintRoot),
    readGraph(blueprintRoot),
    readTasks(blueprintRoot),
    readExports(blueprintRoot),
    readTuiSessions(blueprintRoot),
  ]);
  const registryModels = profile.profile ? await readRegistryModels(root, profile.profile) : [];

  return {
    root,
    setup,
    profile,
    doctor,
    lint,
    manifest,
    graph,
    tasks,
    registryModels,
    exports,
    tuiSessions,
    nextAction: inferNextAction({ setup, profile, lint, tasks, manifest }),
  };
}

export async function runTuiDashboard(options: TuiDashboardOptions): Promise<void> {
  const dashboard = await loadTuiDashboard(options);
  const view = options.initialView ?? "overview";

  if (!process.stdout.isTTY) {
    console.log(renderTuiDashboardToString(dashboard, view));
    return;
  }

  const element = h(InteractiveDashboard, { dashboard, initialView: view });
  const instance = render(element, {
    exitOnCtrlC: true,
    interactive: true,
    alternateScreen: false,
  });

  await instance.waitUntilExit();
}

export function renderTuiDashboardToString(dashboard: TuiDashboard, view: TuiView = "overview"): string {
  return renderToString(h(BlueprintDashboard, { dashboard, view }));
}

export function parseTuiView(value: string): TuiView {
  if (TUI_VIEWS.includes(value as TuiView)) {
    return value as TuiView;
  }

  throw new Error(`Unknown TUI view: ${value}. Expected one of: ${TUI_VIEWS.join(", ")}.`);
}

export function getTuiActions(dashboard: TuiDashboard): TuiAction[] {
  const lintOk = dashboard.lint.errors.length === 0;
  const profileReady = Boolean(dashboard.profile.profile && dashboard.profile.errors.length === 0);
  const needsSetup =
    !dashboard.setup.initialized || !dashboard.profile.profile || dashboard.profile.errors.length > 0 || !dashboard.manifest;
  const setupAction: TuiAction = {
    id: "setup",
    label: "Setup Project",
    command: "blueprint init + profile init",
    description: "Create missing local Blueprint files after confirmation.",
    enabled: true,
    requiresConfirmation: true,
  };

  const actions: TuiAction[] = [
    {
      id: "plan",
      label: "Start Planning Chat",
      command: "blueprint plan",
      description: "Open a chat-like planning flow, preview task-model assignments, then write handoffs.",
      enabled: profileReady,
      requiresConfirmation: false,
      requiresInput: true,
    },
    {
      id: "model-pool",
      label: "Configure Model Pool",
      command: 'profile available_models "<ids|all>"',
      description: "Update profile.yaml with exact model ids for routing.",
      enabled: profileReady,
      requiresConfirmation: false,
      requiresInput: true,
    },
    {
      id: "registry-refresh",
      label: "Refresh Registry",
      command: "blueprint registry refresh",
      description: "Sync project model_registry.yaml with bundled models and preserve custom ids.",
      enabled: profileReady,
      requiresConfirmation: true,
    },
    {
      id: "lint",
      label: "Lint Blueprint",
      command: "blueprint lint",
      description: "Validate generated blueprint artifacts.",
      enabled: true,
      requiresConfirmation: false,
    },
    {
      id: "export",
      label: "Export Handoffs",
      command: "blueprint export",
      description: "Create a transportable handoff package.",
      enabled: lintOk,
      requiresConfirmation: false,
    },
    {
      id: "revise",
      label: "Revise Preview",
      command: 'blueprint revise --change "<text>" --dry-run',
      description: "Preview a targeted revision before applying it.",
      enabled: dashboard.tasks.length > 0,
      requiresConfirmation: false,
      requiresInput: true,
    },
    {
      id: "auth-doctor",
      label: "Auth Doctor",
      command: "blueprint auth doctor",
      description: "Check local provider CLIs without model calls.",
      enabled: true,
      requiresConfirmation: false,
    },
    {
      id: "auth-doctor-live",
      label: "Live Auth Doctor",
      command: "blueprint auth doctor --live",
      description: "Run provider smoke checks that may consume quota.",
      enabled: true,
      requiresConfirmation: true,
    },
  ];

  return needsSetup ? [setupAction, ...actions] : actions;
}

export async function runTuiAction(options: RunTuiActionOptions): Promise<TuiActionResult> {
  let result: TuiActionResult;

  try {
    result = await executeTuiAction(options);
  } catch (error) {
    result = {
      actionId: options.actionId,
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      lines: [],
      change: options.change,
    };
  }

  if (options.recordHistory !== false) {
    result.sessionPath = await writeTuiSessionRecord(options, result);
  }

  return result;
}

async function executeTuiAction(options: RunTuiActionOptions): Promise<TuiActionResult> {
  if (options.actionId === "setup") {
    return setupBlueprintProject(options);
  }

  if (options.actionId === "plan") {
    return runPlanTuiAction(options);
  }

  if (options.actionId === "lint") {
    const result = await lintBlueprint(options.root);

    return {
      actionId: options.actionId,
      status: result.errors.length === 0 ? "ok" : "failed",
      summary:
        result.errors.length === 0
          ? `Blueprint lint passed with ${result.warnings.length} warning(s).`
          : `Blueprint lint failed with ${result.errors.length} error(s).`,
      lines: [...result.errors.map((error) => `error ${error}`), ...result.warnings.map((warning) => `warning ${warning}`)],
    };
  }

  if (options.actionId === "model-pool") {
    const input = options.modelPool?.trim();

    if (!input) {
      return {
        actionId: options.actionId,
        status: "failed",
        summary: "Missing model pool input.",
        lines: ['Enter comma-separated model ids, or "all" to reset to provider defaults.'],
      };
    }

    const result = await updatePlannerProfileModels({
      root: options.root,
      models: parseTuiModelPoolInput(input),
    });

    return {
      actionId: options.actionId,
      status: "ok",
      summary: `Model pool updated with ${result.profile.available_models.length} model(s).`,
      lines: [
        `planner ${result.profile.planner_provider}/${result.profile.planner_model}`,
        `models ${result.profile.available_models.join(",")}`,
        ...result.warnings.map((warning) => `warning ${warning}`),
      ],
    };
  }

  if (options.actionId === "registry-refresh") {
    const result = await refreshModelRegistry({ root: options.root });

    return {
      actionId: options.actionId,
      status: "ok",
      summary: `${result.created ? "Created" : "Refreshed"} model registry with ${result.registry.models.length} model(s).`,
      lines: [
        `path ${result.path}`,
        `added ${result.added.length ? result.added.join(",") : "none"}`,
        `updated ${result.updated.length ? result.updated.join(",") : "none"}`,
        `preserved_custom ${result.preserved_custom.length ? result.preserved_custom.join(",") : "none"}`,
      ],
    };
  }

  if (options.actionId === "export") {
    const result = await exportBlueprint({ root: options.root });

    return formatExportActionResult(options.actionId, result);
  }

  if (options.actionId === "revise") {
    const change = options.change?.trim();

    if (!change) {
      return {
        actionId: options.actionId,
        status: "failed",
        summary: "Missing revise change text.",
        lines: ['Enter a change request, for example: "Adicione criterio de lint na task 002."'],
      };
    }

    const result = await reviseBlueprint({
      root: options.root,
      change,
      apply: options.apply,
      dryRun: !options.apply,
    });

    return formatReviseActionResult(options.actionId, result, change, Boolean(options.apply));
  }

  if (options.actionId === "auth-doctor" || options.actionId === "auth-doctor-live") {
    const live = options.actionId === "auth-doctor-live";
    const results = options.providerChecker
      ? await options.providerChecker(live)
      : await Promise.all(
          DEFAULT_PROVIDER_ADAPTERS.map((adapter) =>
            checkProviderAuth(adapter, {
              live,
              liveTimeoutMs: options.liveTimeoutMs,
            }),
          ),
        );
    const failed = results.filter((result) => !result.installed || result.authCheck === "failed");

    return {
      actionId: options.actionId,
      status: failed.length === 0 ? "ok" : "failed",
      summary: `Checked ${results.length} provider(s); ${failed.length} failed.`,
      lines: results.map((result) => `${result.id} ${result.installed ? "installed" : "missing"} ${result.authCheck} ${result.detail}`),
    };
  }

  return {
    actionId: options.actionId,
    status: "failed",
    summary: `Unknown action ${options.actionId}.`,
    lines: [],
  };
}

async function runPlanTuiAction(options: RunTuiActionOptions): Promise<TuiActionResult> {
  if (!options.planAnswers) {
    return {
      actionId: "plan",
      status: "failed",
      summary: "Missing planning answers.",
      lines: ["Start the planning chat from the TUI and answer each prompt."],
    };
  }

  const engine = options.planEngine ?? "deterministic";
  const force = Boolean(options.planForce);

  if (!options.apply) {
    const preview = await previewBlueprintPlan({
      root: options.root,
      answers: options.planAnswers,
      engine,
      force,
    });

    return {
      actionId: "plan",
      status: "ok",
      summary: `Plan preview ready with ${preview.tasks.length} task(s).`,
      canApply: true,
      lines: [
        `engine ${preview.engine}`,
        `overview ${preview.overview}`,
        ...preview.tasks.map((task) => {
          const deps = task.dependencies.length > 0 ? task.dependencies.join(",") : "none";
          const paths = task.allowedPaths.length > 0 ? task.allowedPaths.join(",") : "read-only";
          return `${task.id} model ${task.suggestedModel} risk ${task.riskLevel} deps ${deps} paths ${paths}`;
        }),
        force ? "warning existing generated tasks will be replaced after confirmation" : "write pending confirmation",
      ],
    };
  }

  const result = await generateBlueprintPlan({
    root: options.root,
    answers: options.planAnswers,
    engine,
    force,
  });
  const lint = await lintBlueprint(options.root);

  return {
    actionId: "plan",
    status: lint.errors.length === 0 ? "ok" : "failed",
    summary:
      lint.errors.length === 0
        ? `Generated ${result.files.length} blueprint file(s) with ${result.taskIds.length} task(s).`
        : `Generated plan failed lint with ${lint.errors.length} error(s).`,
    lines: [
      `engine ${result.engine}`,
      `tasks ${result.taskIds.join(",")}`,
      `artifact_root ${BLUEPRINT_DIR}`,
      `tasks_dir ${BLUEPRINT_DIR}/tasks`,
      `graph ${BLUEPRINT_DIR}/dependencies_graph.json`,
      `integration ${BLUEPRINT_DIR}/integration_guide.md`,
      ...result.files.map((file) => `file ${file}`),
      ...lint.errors.map((error) => `error ${error}`),
      ...lint.warnings.map((warning) => `warning ${warning}`),
    ],
  };
}

async function setupBlueprintProject(options: RunTuiActionOptions): Promise<TuiActionResult> {
  const root = path.resolve(options.root);
  const providerResults = options.providerChecker
    ? await options.providerChecker(false)
    : await Promise.all(DEFAULT_PROVIDER_ADAPTERS.map((adapter) => checkProvider(adapter)));
  const providers = options.providers && options.providers.length > 0
    ? options.providers
    : chooseSetupProviders(providerResults);
  const plannerProvider = options.plannerProvider ?? chooseSetupPlanner(providers);
  let profileResult = await loadPlannerProfile(root);
  let createdProfile = false;
  const lines = [
    `providers ${providers.join(",")}`,
    `models ${options.models?.join(",") ?? "default_for_selected_providers"}`,
    `planner ${plannerProvider}${options.plannerModel ? `/${options.plannerModel}` : ""}`,
  ];

  for (const result of providerResults) {
    if (providers.includes(result.id) && !result.installed) {
      lines.push(`warning provider ${result.id} cli not detected (${result.detail})`);
    }
  }

  if (!profileResult.profile) {
    const written = await initPlannerProfile({
      root,
      providers,
      models: options.models,
      plannerProvider,
      plannerModel: options.plannerModel,
      modelRegistrySource: "project",
    });

    createdProfile = written.written;
    lines.push(`${written.written ? "created" : "exists"} ${path.relative(root, written.path)}`);

    for (const warning of written.warnings) {
      lines.push(`warning ${warning}`);
    }
  }

  const initializedFiles = await initBlueprint({ root });
  lines.push(`blueprint ${initializedFiles.length > 0 ? `created ${initializedFiles.length} file(s)` : "already exists"}`);

  profileResult = await loadPlannerProfile(root);

  if (profileResult.profile?.model_registry.source === "project" && !createdProfile) {
    const registry = await exportModelRegistry({
      root,
      path: profileResult.profile.model_registry.path,
    });

    lines.push(`${registry.written ? "created" : "exists"} ${path.relative(root, registry.path)}`);

    for (const warning of registry.warnings) {
      lines.push(`warning ${warning}`);
    }
  }

  const finalProfile = await loadPlannerProfile(root);

  for (const error of finalProfile.errors) {
    lines.push(`error ${error}`);
  }

  for (const warning of finalProfile.warnings) {
    lines.push(`warning ${warning}`);
  }

  return {
    actionId: options.actionId,
    status: finalProfile.errors.length === 0 ? "ok" : "failed",
    summary:
      finalProfile.errors.length === 0
        ? "Blueprint setup completed. Run blueprint plan next."
        : "Blueprint setup needs manual attention.",
    lines,
  };
}

function chooseSetupProviders(results: ProviderDoctorResult[]): ProviderId[] {
  const installed = new Set(results.filter((result) => result.installed).map((result) => result.id));
  const preferred = (["openai", "google", "anthropic"] as ProviderId[]).filter((provider) => installed.has(provider));
  const withoutAnthropic = preferred.filter((provider) => provider !== "anthropic");

  if (withoutAnthropic.length > 0) {
    return withoutAnthropic;
  }

  if (preferred.length > 0) {
    return preferred;
  }

  return ["google"];
}

function chooseSetupPlanner(providers: ProviderId[]): ProviderId {
  if (providers.includes("google")) {
    return "google";
  }

  if (providers.includes("openai")) {
    return "openai";
  }

  return providers[0] ?? "google";
}

function makeDefaultSetupDraft(): SetupDraft {
  const providers = [...SETUP_PROVIDER_OPTIONS];
  const models = defaultSetupModelIds(providers);

  return normalizeSetupDraft({
    providers,
    models,
    plannerModel: chooseDefaultPlannerModel(models),
  });
}

function setupModelsForProvider(provider: ProviderId): ModelRegistryEntry[] {
  return DEFAULT_MODEL_REGISTRY.filter((model) => model.provider === provider && model.status !== "restricted");
}

function defaultSetupModelIds(providers: readonly ProviderId[]): string[] {
  const selectedProviders = new Set(providers);

  return DEFAULT_MODEL_REGISTRY.filter(
    (model) => selectedProviders.has(model.provider) && model.status !== "restricted",
  ).map((model) => model.id);
}

function reconcileSetupDraft(current: SetupDraft, providers: ProviderId[]): SetupDraft {
  const previousProviders = new Set(current.providers);
  const nextProviders = [...providers].sort(byProviderOrder);
  const currentModels = new Set(current.models);
  const nextModelIds = nextProviders.flatMap((provider) => {
    const providerModels = setupModelsForProvider(provider).map((model) => model.id);

    if (!previousProviders.has(provider)) {
      return providerModels;
    }

    return providerModels.filter((modelId) => currentModels.has(modelId));
  });

  return normalizeSetupDraft({
    providers: nextProviders,
    models: sortModelIds(nextModelIds),
    plannerModel: current.plannerModel,
  });
}

function updateSetupModelsForProvider(draft: SetupDraft, provider: ProviderId, modelIds: string[]): SetupDraft {
  const providerModelIds = new Set(setupModelsForProvider(provider).map((model) => model.id));
  const otherModels = draft.models.filter((modelId) => !providerModelIds.has(modelId));

  return normalizeSetupDraft({
    ...draft,
    models: sortModelIds([...otherModels, ...modelIds]),
  });
}

function normalizeSetupDraft(draft: SetupDraft): SetupDraft {
  const providers = [...draft.providers].sort(byProviderOrder);
  const providerSet = new Set(providers);
  const models = sortModelIds(draft.models.filter((modelId) => {
    const provider = providerForModelId(modelId);
    return provider ? providerSet.has(provider) : false;
  }));
  const plannerModel = draft.plannerModel && models.includes(draft.plannerModel)
    ? draft.plannerModel
    : chooseDefaultPlannerModel(models);

  return {
    providers,
    models,
    plannerModel,
  };
}

function setupPlannerModels(modelIds: string[]): ModelRegistryEntry[] {
  const selected = new Set(modelIds);

  return DEFAULT_MODEL_REGISTRY.filter((model) => selected.has(model.id)).sort((left, right) => {
    const planningDiff = (right.task_fit.planning ?? 0) - (left.task_fit.planning ?? 0);

    if (planningDiff !== 0) {
      return planningDiff;
    }

    return byProviderOrder(left.provider, right.provider) || left.id.localeCompare(right.id);
  });
}

function chooseDefaultPlannerModel(modelIds: string[]): string | undefined {
  return setupPlannerModels(modelIds)[0]?.id;
}

function providerForModelId(modelId: string): ProviderId | undefined {
  return DEFAULT_MODEL_REGISTRY.find((model) => model.id === modelId)?.provider;
}

function sortModelIds(modelIds: string[]): string[] {
  const selected = new Set(modelIds);

  return DEFAULT_MODEL_REGISTRY.filter((model) => selected.has(model.id)).map((model) => model.id);
}

function byProviderOrder(left: ProviderId, right: ProviderId): number {
  return SETUP_PROVIDER_OPTIONS.indexOf(left) - SETUP_PROVIDER_OPTIONS.indexOf(right);
}

function formatScore(score: number | undefined): string {
  return typeof score === "number" ? score.toFixed(2) : "n/a";
}

export function InteractiveDashboard({
  dashboard,
  initialView,
}: {
  dashboard: TuiDashboard;
  initialView: TuiView;
}): React.ReactElement {
  const { exit } = useApp();
  const [dashboardState, setDashboardState] = useState<TuiDashboard>(dashboard);
  const [view, setView] = useState<TuiView>(initialView);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [actionResult, setActionResult] = useState<TuiActionResult | undefined>();
  const [runningAction, setRunningAction] = useState<TuiActionId | undefined>();
  const [pendingConfirmation, setPendingConfirmation] = useState<TuiActionId | undefined>();
  const [isEditingRevise, setIsEditingRevise] = useState(false);
  const [reviseInput, setReviseInput] = useState("");
  const [lastReviseChange, setLastReviseChange] = useState<string | undefined>();
  const [planChatStep, setPlanChatStep] = useState<PlanChatStep>("idle");
  const [planChatDraft, setPlanChatDraft] = useState<PlanChatDraft>({});
  const [planChatInput, setPlanChatInput] = useState("");
  const [lastPlanAnswers, setLastPlanAnswers] = useState<PlanAnswers | undefined>();
  const [lastPlanForce, setLastPlanForce] = useState(false);
  const [isEditingModelPool, setIsEditingModelPool] = useState(false);
  const [modelPoolInput, setModelPoolInput] = useState("");
  const [isEditingRoot, setIsEditingRoot] = useState(false);
  const [rootInputMode, setRootInputMode] = useState<"choose" | "create">("choose");
  const [rootInput, setRootInput] = useState(dashboard.root);
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupDraft, setSetupDraft] = useState<SetupDraft>(() => makeDefaultSetupDraft());
  const [setupProviderCursor, setSetupProviderCursor] = useState(0);
  const [setupModelProviderCursor, setSetupModelProviderCursor] = useState(0);
  const [setupModelCursor, setSetupModelCursor] = useState(0);
  const [setupPlannerCursor, setSetupPlannerCursor] = useState(0);
  const actions = getTuiActions(dashboardState);

  useInput((input, key) => {
    if (isEditingRoot) {
      if (key.escape) {
        setIsEditingRoot(false);
        setRootInput(dashboardState.root);
        return;
      }

      if (key.backspace || key.delete) {
        setRootInput((current) => current.slice(0, -1));
        return;
      }

      if (key.return) {
        const nextRoot =
          rootInputMode === "create"
            ? path.resolve(dashboardState.root, rootInput.trim())
            : resolveUserRoot(rootInput, dashboardState.root);

        if (rootInputMode === "create" && rootInput.trim().length === 0) {
          setActionResult({
            actionId: "setup",
            status: "failed",
            summary: "Directory name is required.",
            lines: ["Type a folder name, or press Esc to cancel."],
          });
          return;
        }

        setIsEditingRoot(false);
        setActionResult(undefined);
        setPendingConfirmation(undefined);
        setSelectedActionIndex(0);
        void mkdir(nextRoot, { recursive: rootInputMode === "create" })
          .then(() => loadTuiDashboard({ root: nextRoot }))
          .then((nextDashboard) => {
            setDashboardState(nextDashboard);
            setRootInput(nextDashboard.root);
            setView(nextDashboard.setup.initialized ? "overview" : "actions");
            setSetupStep(nextDashboard.setup.initialized ? "idle" : "providers");
            setPendingConfirmation(undefined);
          })
          .catch((error: unknown) => {
            setActionResult({
              actionId: "setup",
              status: "failed",
              summary: error instanceof Error ? error.message : String(error),
              lines: [],
            });
          });
        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setRootInput((current) => `${current}${input}`);
      }

      return;
    }

    if (view === "actions" && planChatStep !== "idle") {
      if (key.escape) {
        setPlanChatStep("idle");
        setPlanChatInput("");
        return;
      }

      if (key.backspace || key.delete) {
        setPlanChatInput((current) => current.slice(0, -1));
        return;
      }

      if (key.return) {
        submitPlanChatInput();
        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setPlanChatInput((current) => `${current}${input}`);
      }

      return;
    }

    if (view === "actions" && isEditingModelPool) {
      if (key.escape) {
        setIsEditingModelPool(false);
        return;
      }

      if (key.backspace || key.delete) {
        setModelPoolInput((current) => current.slice(0, -1));
        return;
      }

      if (key.return) {
        const modelPool = modelPoolInput.trim();

        if (modelPool.length > 0) {
          setIsEditingModelPool(false);
          void executeAction("model-pool", { modelPool });
        }

        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setModelPoolInput((current) => `${current}${input}`);
      }

      return;
    }

    if (view === "actions" && isEditingRevise) {
      if (key.escape) {
        setIsEditingRevise(false);
        return;
      }

      if (key.backspace || key.delete) {
        setReviseInput((current) => current.slice(0, -1));
        return;
      }

      if (key.return) {
        const change = reviseInput.trim();

        if (change.length > 0) {
          setIsEditingRevise(false);
          void executeAction("revise", { change, apply: false });
        }

        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setReviseInput((current) => `${current}${input}`);
      }

      return;
    }

    if (!dashboardState.setup.initialized && setupStep !== "idle") {
      handleSetupInput(input, key);
      return;
    }

    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input.toLowerCase() === "c") {
      setRootInput("");
      setRootInputMode("choose");
      setIsEditingRoot(true);
      return;
    }

    if (!dashboardState.setup.initialized) {
      if (key.return || input === "1") {
        setView("actions");
        setSelectedActionIndex(0);
        beginSetupFlow();
        return;
      }

      if (input === "2") {
        setRootInput("");
        setRootInputMode("create");
        setIsEditingRoot(true);
        return;
      }

      if (input === "3") {
        setRootInput("");
        setRootInputMode("choose");
        setIsEditingRoot(true);
        return;
      }

      return;
    }

    if (key.rightArrow || input === "\t") {
      setView(nextView(view));
      return;
    }

    if (key.leftArrow) {
      setView(previousView(view));
      return;
    }

    if (view === "actions" && key.downArrow) {
      setSelectedActionIndex((index) => Math.min(index + 1, actions.length - 1));
      return;
    }

    if (view === "actions" && key.upArrow) {
      setSelectedActionIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (pendingConfirmation && view === "actions") {
      if (input.toLowerCase() === "y") {
        void executeAction(pendingConfirmation, {
          apply: pendingConfirmation === "revise" || pendingConfirmation === "plan",
          change: pendingConfirmation === "revise" ? lastReviseChange : undefined,
          planAnswers: pendingConfirmation === "plan" ? lastPlanAnswers : undefined,
          planForce: pendingConfirmation === "plan" ? lastPlanForce : undefined,
        });
      }

      if (input.toLowerCase() === "n") {
        setPendingConfirmation(undefined);
      }

      return;
    }

    if (view === "actions" && key.return) {
      const action = actions[selectedActionIndex];

      if (!action || !action.enabled || runningAction) {
        return;
      }

      if (action.requiresConfirmation) {
        setPendingConfirmation(action.id);
        return;
      }

      if (action.requiresInput) {
        if (action.id === "plan") {
          beginPlanChat();
          return;
        }

        if (action.id === "model-pool") {
          setModelPoolInput(dashboardState.profile.profile?.available_models.join(",") || "all");
          setIsEditingModelPool(true);
          return;
        }

        setReviseInput(lastReviseChange ?? "");
        setIsEditingRevise(true);
        return;
      }

      void executeAction(action.id, {});
      return;
    }

    const numeric = Number(input);

    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= TUI_VIEWS.length) {
      setView(TUI_VIEWS[numeric - 1]!);
    }
  });

  function beginPlanChat(): void {
    setPlanChatDraft({});
    setPlanChatInput("");
    setLastPlanAnswers(undefined);
    setLastPlanForce(false);
    setPendingConfirmation(undefined);
    setActionResult(undefined);
    setPlanChatStep("projectSummary");
  }

  function submitPlanChatInput(): void {
    const value = planChatInput.trim();

    if (planChatStep === "idle") {
      return;
    }

    const nextDraft = updatePlanChatDraft(planChatDraft, planChatStep, value);

    if (!nextDraft) {
      setActionResult({
        actionId: "plan",
        status: "failed",
        summary: planChatValidationMessage(planChatStep),
        lines: [PLAN_STEP_PROMPTS[planChatStep]],
      });
      return;
    }

    const nextStep = nextPlanChatStep(planChatStep);
    setPlanChatDraft(nextDraft);
    setPlanChatInput("");
    setActionResult(undefined);

    if (nextStep) {
      setPlanChatStep(nextStep);
      return;
    }

    const answers = buildPlanAnswersFromDraft(nextDraft);
    const force = dashboardState.tasks.length > 0;
    setPlanChatStep("idle");
    setLastPlanAnswers(answers);
    setLastPlanForce(force);
    void executeAction("plan", {
      planAnswers: answers,
      planForce: force,
      apply: false,
    });
  }

  function beginSetupFlow(): void {
    const draft = makeDefaultSetupDraft();
    setSetupDraft(draft);
    setSetupProviderCursor(0);
    setSetupModelProviderCursor(0);
    setSetupModelCursor(0);
    setSetupPlannerCursor(0);
    setSetupStep("providers");
    setPendingConfirmation(undefined);
    setActionResult(undefined);
  }

  function handleSetupInput(
    input: string,
    key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
  ): void {
    if (key.escape) {
      setSetupStep("idle");
      setActionResult(undefined);
      return;
    }

    if (setupStep === "providers") {
      const maxCursor = SETUP_PROVIDER_OPTIONS.length;

      if (key.upArrow) {
        setSetupProviderCursor((cursor) => Math.max(cursor - 1, 0));
        return;
      }

      if (key.downArrow) {
        setSetupProviderCursor((cursor) => Math.min(cursor + 1, maxCursor));
        return;
      }

      if (input === " " || input.toLowerCase() === "a") {
        if (setupProviderCursor === 0 || input.toLowerCase() === "a") {
          const allSelected = setupDraft.providers.length === SETUP_PROVIDER_OPTIONS.length;
          setSetupDraft(reconcileSetupDraft(setupDraft, allSelected ? [] : [...SETUP_PROVIDER_OPTIONS]));
          return;
        }

        const provider = SETUP_PROVIDER_OPTIONS[setupProviderCursor - 1];
        if (provider) {
          const providers = setupDraft.providers.includes(provider)
            ? setupDraft.providers.filter((selected) => selected !== provider)
            : [...setupDraft.providers, provider].sort(byProviderOrder);
          setSetupDraft(reconcileSetupDraft(setupDraft, providers));
        }

        return;
      }

      if (key.return) {
        if (setupDraft.providers.length === 0) {
          setActionResult({
            actionId: "setup",
            status: "failed",
            summary: "Select at least one provider.",
            lines: ["Use Space to toggle providers, or press a to select all."],
          });
          return;
        }

        setSetupModelProviderCursor(0);
        setSetupModelCursor(0);
        setSetupStep("models");
        setActionResult(undefined);
        return;
      }
    }

    if (setupStep === "models") {
      const provider = setupDraft.providers[setupModelProviderCursor];
      const models = provider ? setupModelsForProvider(provider) : [];
      const maxCursor = models.length;

      if (input.toLowerCase() === "b") {
        if (setupModelProviderCursor > 0) {
          setSetupModelProviderCursor((cursor) => cursor - 1);
          setSetupModelCursor(0);
        } else {
          setSetupStep("providers");
        }
        return;
      }

      if (key.upArrow) {
        setSetupModelCursor((cursor) => Math.max(cursor - 1, 0));
        return;
      }

      if (key.downArrow) {
        setSetupModelCursor((cursor) => Math.min(cursor + 1, maxCursor));
        return;
      }

      if (provider && (input === " " || input.toLowerCase() === "a")) {
        const providerModelIds = models.map((model) => model.id);
        const selectedForProvider = providerModelIds.filter((modelId) => setupDraft.models.includes(modelId));

        if (setupModelCursor === 0 || input.toLowerCase() === "a") {
          const allSelected = selectedForProvider.length === providerModelIds.length;
          setSetupDraft(updateSetupModelsForProvider(setupDraft, provider, allSelected ? [] : providerModelIds));
          return;
        }

        const model = models[setupModelCursor - 1];

        if (model) {
          const nextSelected = setupDraft.models.includes(model.id)
            ? setupDraft.models.filter((modelId) => modelId !== model.id)
            : [...setupDraft.models, model.id];
          setSetupDraft(normalizeSetupDraft({ ...setupDraft, models: sortModelIds(nextSelected) }));
        }

        return;
      }

      if (key.return) {
        if (!provider) {
          setSetupStep("providers");
          return;
        }

        if (!setupDraft.models.some((modelId) => providerForModelId(modelId) === provider)) {
          setActionResult({
            actionId: "setup",
            status: "failed",
            summary: `Select at least one ${provider} model.`,
            lines: ["Use Space to toggle models, or press a to select all models for this provider."],
          });
          return;
        }

        if (setupModelProviderCursor < setupDraft.providers.length - 1) {
          setSetupModelProviderCursor((cursor) => cursor + 1);
          setSetupModelCursor(0);
          setActionResult(undefined);
          return;
        }

        const plannerModels = setupPlannerModels(setupDraft.models);
        const plannerIndex = Math.max(
          plannerModels.findIndex((model) => model.id === setupDraft.plannerModel),
          0,
        );
        setSetupPlannerCursor(plannerIndex);
        setSetupStep("planner");
        setActionResult(undefined);
        return;
      }
    }

    if (setupStep === "planner") {
      const models = setupPlannerModels(setupDraft.models);

      if (input.toLowerCase() === "b") {
        setSetupStep("models");
        return;
      }

      if (key.upArrow) {
        setSetupPlannerCursor((cursor) => Math.max(cursor - 1, 0));
        return;
      }

      if (key.downArrow) {
        setSetupPlannerCursor((cursor) => Math.min(cursor + 1, Math.max(models.length - 1, 0)));
        return;
      }

      if (key.return || input === " ") {
        const plannerModel = models[setupPlannerCursor]?.id ?? chooseDefaultPlannerModel(setupDraft.models);

        if (!plannerModel) {
          setActionResult({
            actionId: "setup",
            status: "failed",
            summary: "Select at least one model before choosing a planner.",
            lines: ["Press b to return to model selection."],
          });
          return;
        }

        setSetupDraft(normalizeSetupDraft({ ...setupDraft, plannerModel }));
        setSetupStep("confirm");
        setActionResult(undefined);
        return;
      }
    }

    if (setupStep === "confirm") {
      if (input.toLowerCase() === "b" || input.toLowerCase() === "n") {
        setSetupStep("planner");
        return;
      }

      if (input.toLowerCase() === "y" || key.return) {
        const plannerModel = setupDraft.plannerModel ?? chooseDefaultPlannerModel(setupDraft.models);
        const plannerProvider = plannerModel ? providerForModelId(plannerModel) : undefined;

        if (!plannerModel || !plannerProvider) {
          setActionResult({
            actionId: "setup",
            status: "failed",
            summary: "Planner model is required.",
            lines: ["Press b and choose one model as the planner."],
          });
          return;
        }

        setSetupStep("idle");
        void executeAction("setup", {
          providers: setupDraft.providers,
          models: setupDraft.models,
          plannerProvider,
          plannerModel,
        });
      }
    }
  }

  async function executeAction(
    actionId: TuiActionId,
    options: {
      change?: string;
      modelPool?: string;
      planAnswers?: PlanAnswers;
      planEngine?: PlanEngine;
      planForce?: boolean;
      providers?: ProviderId[];
      models?: string[];
      plannerProvider?: ProviderId;
      plannerModel?: string;
      apply?: boolean;
    } = {},
  ): Promise<void> {
    setPendingConfirmation(undefined);
    setRunningAction(actionId);
    setActionResult(undefined);

    try {
      const result = await runTuiAction({
        root: dashboardState.root,
        actionId,
        change: options.change,
        modelPool: options.modelPool,
        planAnswers: options.planAnswers,
        planEngine: options.planEngine,
        planForce: options.planForce,
        providers: options.providers,
        models: options.models,
        plannerProvider: options.plannerProvider,
        plannerModel: options.plannerModel,
        apply: options.apply,
      });
      setActionResult(result);

      if (result.actionId === "revise" && result.change) {
        setLastReviseChange(result.change);

        if (result.canApply && !options.apply) {
          setPendingConfirmation("revise");
        }
      }

      if (result.actionId === "plan" && result.canApply && !options.apply) {
        setPendingConfirmation("plan");
      }

      setDashboardState(await loadTuiDashboard({ root: dashboardState.root }));
    } catch (error) {
      setActionResult({
        actionId,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        lines: [],
      });
    } finally {
      setRunningAction(undefined);
    }
  }

  return h(BlueprintDashboard, {
    dashboard: dashboardState,
    view,
    selectedActionIndex,
    actionResult,
    runningAction,
    pendingConfirmation,
    isEditingRevise,
    reviseInput,
    planChatStep,
    planChatDraft,
    planChatInput,
    isEditingModelPool,
    modelPoolInput,
    isEditingRoot,
    rootInputMode,
    rootInput,
    setupStep,
    setupDraft,
    setupProviderCursor,
    setupModelProviderCursor,
    setupModelCursor,
    setupPlannerCursor,
  });
}

export function BlueprintDashboard({
  dashboard,
  view = "overview",
  selectedActionIndex = 0,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  planChatStep = "idle",
  planChatDraft = {},
  planChatInput = "",
  isEditingModelPool,
  modelPoolInput,
  isEditingRoot,
  rootInputMode,
  rootInput,
  setupStep = "idle",
  setupDraft = makeDefaultSetupDraft(),
  setupProviderCursor = 0,
  setupModelProviderCursor = 0,
  setupModelCursor = 0,
  setupPlannerCursor = 0,
}: {
  dashboard: TuiDashboard;
  view?: TuiView;
  selectedActionIndex?: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isEditingRoot?: boolean;
  rootInputMode?: "choose" | "create";
  rootInput?: string;
  setupStep?: SetupStep;
  setupDraft?: SetupDraft;
  setupProviderCursor?: number;
  setupModelProviderCursor?: number;
  setupModelCursor?: number;
  setupPlannerCursor?: number;
}): React.ReactElement {
  const lintStatus = dashboard.lint.errors.length === 0 ? "ok" : "error";
  const appStatus = dashboard.setup.initialized ? lintStatus : "warn";

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: appStatus === "ok" ? "green" : appStatus === "warn" ? "yellow" : "red",
        paddingX: 1,
      },
      h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `${statusIcon(appStatus)} Blueprint Agent Harness`),
        h(Text, null, dashboard.root),
      ),
    ),
    ...(dashboard.setup.initialized ? [h(TabBar, { key: "tabs", activeView: view })] : []),
    h(ActiveView, {
      dashboard,
      view,
      lintStatus,
      selectedActionIndex,
      actionResult,
      runningAction,
      pendingConfirmation,
      isEditingRevise,
      reviseInput,
      planChatStep,
      planChatDraft,
      planChatInput,
      isEditingModelPool,
      modelPoolInput,
      isEditingRoot,
      rootInputMode,
      rootInput,
      setupStep,
      setupDraft,
      setupProviderCursor,
      setupModelProviderCursor,
      setupModelCursor,
      setupPlannerCursor,
    }),
    h(KeyHints, {
      view,
      setupInitialized: dashboard.setup.initialized,
      pendingConfirmation,
      isEditingRevise,
      planChatStep,
      isEditingModelPool,
      isEditingRoot,
      runningAction,
      setupStep,
    }),
  );
}

function ActiveView({
  dashboard,
  view,
  lintStatus,
  selectedActionIndex,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  planChatStep,
  planChatDraft,
  planChatInput,
  isEditingModelPool,
  modelPoolInput,
  isEditingRoot,
  rootInputMode,
  rootInput,
  setupStep,
  setupDraft,
  setupProviderCursor,
  setupModelProviderCursor,
  setupModelCursor,
  setupPlannerCursor,
}: {
  dashboard: TuiDashboard;
  view: TuiView;
  lintStatus: "ok" | "error";
  selectedActionIndex: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isEditingRoot?: boolean;
  rootInputMode?: "choose" | "create";
  rootInput?: string;
  setupStep?: SetupStep;
  setupDraft?: SetupDraft;
  setupProviderCursor?: number;
  setupModelProviderCursor?: number;
  setupModelCursor?: number;
  setupPlannerCursor?: number;
}): React.ReactElement {
  if (isEditingRoot || !dashboard.setup.initialized) {
    return h(SetupView, {
      dashboard,
      isEditingRoot,
      rootInputMode,
      rootInput,
      pendingConfirmation,
      runningAction,
      actionResult,
      setupStep,
      setupDraft,
      setupProviderCursor,
      setupModelProviderCursor,
      setupModelCursor,
      setupPlannerCursor,
    });
  }

  if (view === "tasks") {
    return h(TaskView, { dashboard });
  }

  if (view === "graph") {
    return h(GraphView, { dashboard });
  }

  if (view === "providers") {
    return h(ProvidersView, { dashboard });
  }

  if (view === "actions") {
    return h(ActionsView, {
      dashboard,
      selectedActionIndex,
      actionResult,
      runningAction,
      pendingConfirmation,
      isEditingRevise,
      reviseInput,
      planChatStep,
      planChatDraft,
      planChatInput,
      isEditingModelPool,
      modelPoolInput,
    });
  }

  return h(OverviewView, { dashboard, lintStatus });
}

function SetupView({
  dashboard,
  isEditingRoot,
  rootInputMode,
  rootInput,
  pendingConfirmation,
  runningAction,
  actionResult,
  setupStep = "idle",
  setupDraft = makeDefaultSetupDraft(),
  setupProviderCursor = 0,
  setupModelProviderCursor = 0,
  setupModelCursor = 0,
  setupPlannerCursor = 0,
}: {
  dashboard: TuiDashboard;
  isEditingRoot?: boolean;
  rootInputMode?: "choose" | "create";
  rootInput?: string;
  pendingConfirmation?: TuiActionId;
  runningAction?: TuiActionId;
  actionResult?: TuiActionResult;
  setupStep?: SetupStep;
  setupDraft?: SetupDraft;
  setupProviderCursor?: number;
  setupModelProviderCursor?: number;
  setupModelCursor?: number;
  setupPlannerCursor?: number;
}): React.ReactElement {
  if (isEditingRoot) {
    return h(
      Box,
      { flexDirection: "column", gap: 1 },
      h(
        Box,
        { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
        h(Text, { bold: true }, rootInputMode === "create" ? "Create Project Directory" : "Choose Project Directory"),
        h(Text, null, `Current: ${dashboard.root}`),
        h(Text, null, rootInputMode === "create" ? `Folder name: ${rootInput ?? ""}` : `New path: ${rootInput ?? ""}`),
      ),
      h(
        Box,
        { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
        h(Text, { bold: true }, "Controls"),
        h(Text, null, rootInputMode === "create" ? "Enter creates and opens the folder." : "Enter opens the typed directory."),
        ...(rootInputMode === "choose" ? [h(Text, { key: "empty" }, "Leave empty and press Enter to keep current.")] : []),
        h(Text, null, "Esc cancels."),
      ),
    );
  }

  if (setupStep !== "idle") {
    return h(
      Box,
      { flexDirection: "column", gap: 1 },
      h(
        Box,
        { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
        h(Text, { bold: true }, "Onboarding"),
        h(Text, null, `Current directory: ${dashboard.root}`),
        h(Text, null, "Configure providers, model pool, and planner before the harness writes files."),
      ),
      h(SetupStepPanel, {
        setupStep,
        setupDraft,
        setupProviderCursor,
        setupModelProviderCursor,
        setupModelCursor,
        setupPlannerCursor,
      }),
      ...(runningAction === "setup"
        ? [
            h(
              Box,
              { key: "running", borderStyle: "single", borderColor: "gray", paddingX: 1 },
              h(Text, null, "Running setup..."),
            ),
          ]
        : []),
      ...(actionResult ? [h(ActionResultPanel, { key: "result", result: actionResult })] : []),
    );
  }

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Blueprint not initialized"),
      ...dashboard.setup.messages.map((message) => h(Text, { key: message }, message)),
    ),
    h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Start Here"),
      h(Text, null, "1 or Enter: configure harness in this directory"),
      h(Text, null, "2: create a new project folder here"),
      h(Text, null, "3 or c: choose another directory"),
    ),
    ...(pendingConfirmation === "setup"
      ? [
          h(
            Box,
            { key: "confirm", borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
            h(Text, { bold: true }, "Confirm Setup"),
            h(Text, null, `Create Blueprint config in ${dashboard.root}?`),
            h(Text, null, "Press y to confirm or n to cancel."),
          ),
        ]
      : []),
    ...(runningAction === "setup"
      ? [
          h(
            Box,
            { key: "running", borderStyle: "single", borderColor: "gray", paddingX: 1 },
            h(Text, null, "Running setup..."),
          ),
        ]
      : []),
    ...(actionResult
      ? [
          h(
            Box,
            {
              key: "result",
              borderStyle: "single",
              borderColor: actionResult.status === "ok" ? "green" : "red",
              paddingX: 1,
              flexDirection: "column",
            },
            h(Text, { bold: true }, `${actionResult.actionId} ${actionResult.status}`),
            h(Text, null, actionResult.summary),
            ...actionResult.lines.slice(0, 6).map((line) => h(Text, { key: line }, line)),
          ),
        ]
      : []),
  );
}

function SetupStepPanel({
  setupStep,
  setupDraft,
  setupProviderCursor,
  setupModelProviderCursor,
  setupModelCursor,
  setupPlannerCursor,
}: {
  setupStep: SetupStep;
  setupDraft: SetupDraft;
  setupProviderCursor: number;
  setupModelProviderCursor: number;
  setupModelCursor: number;
  setupPlannerCursor: number;
}): React.ReactElement {
  if (setupStep === "providers") {
    const allSelected = setupDraft.providers.length === SETUP_PROVIDER_OPTIONS.length;

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "1. Provider Pool"),
      h(Text, null, "Choose the provider accounts this project can use."),
      h(
        Text,
        { color: setupProviderCursor === 0 ? "cyan" : undefined, bold: setupProviderCursor === 0 },
        `${setupProviderCursor === 0 ? ">" : " "} [${allSelected ? "x" : " "}] Select all providers`,
      ),
      ...SETUP_PROVIDER_OPTIONS.map((provider, index) => {
        const cursor = index + 1;
        const selected = setupDraft.providers.includes(provider);

        return h(
          Text,
          {
            key: provider,
            color: setupProviderCursor === cursor ? "cyan" : undefined,
            bold: setupProviderCursor === cursor,
          },
          `${setupProviderCursor === cursor ? ">" : " "} [${selected ? "x" : " "}] ${PROVIDER_LABELS[provider]}`,
        );
      }),
      h(Text, { color: "gray" }, "Space toggles, a selects all, Enter continues."),
    );
  }

  if (setupStep === "models") {
    const provider = setupDraft.providers[setupModelProviderCursor];
    const models = provider ? setupModelsForProvider(provider) : [];
    const selectedCount = models.filter((model) => setupDraft.models.includes(model.id)).length;
    const allSelected = models.length > 0 && selectedCount === models.length;

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(
        Text,
        { bold: true },
        `2. Model Pool ${provider ? `(${setupModelProviderCursor + 1}/${setupDraft.providers.length} ${PROVIDER_LABELS[provider]})` : ""}`,
      ),
      h(Text, null, "Choose exact models available for routing."),
      h(
        Text,
        { color: setupModelCursor === 0 ? "cyan" : undefined, bold: setupModelCursor === 0 },
        `${setupModelCursor === 0 ? ">" : " "} [${allSelected ? "x" : " "}] Select all ${provider ?? ""} models`,
      ),
      ...models.map((model, index) => {
        const cursor = index + 1;
        const selected = setupDraft.models.includes(model.id);

        return h(
          Text,
          {
            key: model.id,
            color: setupModelCursor === cursor ? "cyan" : undefined,
            bold: setupModelCursor === cursor,
          },
          `${setupModelCursor === cursor ? ">" : " "} [${selected ? "x" : " "}] ${model.id} ${model.tier}/${model.status}`,
        );
      }),
      h(Text, { color: "gray" }, "Space toggles, a selects all for this provider, b goes back, Enter continues."),
    );
  }

  if (setupStep === "planner") {
    const models = setupPlannerModels(setupDraft.models);

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "3. Planner Model"),
      h(Text, null, "Choose the model that will run the planning conversation."),
      ...models.map((model, index) =>
        h(
          Text,
          {
            key: model.id,
            color: setupPlannerCursor === index ? "cyan" : undefined,
            bold: setupPlannerCursor === index,
          },
          `${setupPlannerCursor === index ? ">" : " "} ${model.id} | ${PROVIDER_LABELS[model.provider]} | planning ${formatScore(model.task_fit.planning)}`,
        ),
      ),
      h(Text, { color: "gray" }, "Up/down selects, b goes back, Enter confirms."),
    );
  }

  const plannerModel = setupDraft.plannerModel ?? chooseDefaultPlannerModel(setupDraft.models) ?? "missing";
  const plannerProvider = providerForModelId(plannerModel);

  return h(
    Box,
    { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "4. Confirm Setup"),
    h(Text, null, `Status: ${plannerProvider ? "ready to write" : "needs planner model"}`),
    h(Text, null, `Providers: ${setupDraft.providers.join(",")}`),
    h(Text, null, `Models: ${setupDraft.models.length} selected`),
    h(Text, null, `Planner: ${plannerProvider ?? "unknown"}/${plannerModel}`),
    h(Text, { color: "gray" }, "Press y or Enter to write .blueprint files, b/n to revise."),
  );
}

function OverviewView({
  dashboard,
  lintStatus,
}: {
  dashboard: TuiDashboard;
  lintStatus: "ok" | "error";
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const profileStatus = dashboard.profile.errors.length === 0 && profile ? "ok" : "error";
  const graphStatus = dashboard.graph ? `${dashboard.graph.nodes.length} nodes / ${dashboard.graph.edges.length} edges` : "missing";
  const exportStatus = dashboard.exports.length > 0 ? `${dashboard.exports.length} package(s)` : "none";
  const sessionStatus = dashboard.tuiSessions.length > 0 ? `${dashboard.tuiSessions.length} record(s)` : "none";

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { gap: 2 },
      h(StatusPanel, {
        title: "Profile",
        status: profileStatus,
        lines: profile
          ? [
              `planner ${profile.planner_provider}/${profile.planner_model}`,
              `providers ${profile.available_providers.join(",")}`,
              `models ${summarizeModels(profile.available_models)}`,
              `fallback ${profile.routing.allow_provider_fallback ? "enabled" : "disabled"}`,
            ]
          : [...dashboard.profile.errors, "", "\u2192 blueprint profile init"],
      }),
      h(StatusPanel, {
        title: "Blueprint",
        status: lintStatus,
        lines: [
          `status ${dashboard.manifest?.status ?? "missing"}`,
          `lint ${dashboard.lint.errors.length} error(s), ${dashboard.lint.warnings.length} warning(s)`,
          `graph ${graphStatus}`,
          `exports ${exportStatus}`,
          ...(lintStatus === "error" ? ["\u2192 blueprint lint"] : []),
        ],
      }),
    ),
    h(
      Box,
      { gap: 2 },
      h(StatusPanel, {
        title: "Context",
        status: dashboard.doctor.warnings.length === 0 ? "ok" : "warn",
        lines: [
          `files ${dashboard.doctor.fileCount}`,
          `canonical ${dashboard.doctor.canonicalFiles.length}`,
          `manifests ${summarizeManifests(dashboard.doctor.manifests)}`,
          ...(dashboard.doctor.fileCount > 10_000 ? ["\u2192 use --root <project>"] : []),
        ],
      }),
      h(StatusPanel, {
        title: "Tasks",
        status: dashboard.tasks.length > 0 ? "ok" : "warn",
        lines:
          dashboard.tasks.length > 0
            ? [
                `count ${dashboard.tasks.length}`,
                `high risk ${dashboard.tasks.filter((task) => task.riskLevel >= 7).length}`,
                `models ${unique(dashboard.tasks.map((task) => task.suggestedModel)).join(",")}`,
              ]
            : ["no generated task handoffs", "\u2192 blueprint plan"],
      }),
    ),
    h(
      Box,
      { gap: 2 },
      h(StatusPanel, {
        title: "Artifacts",
        status: dashboard.manifest && dashboard.tasks.length > 0 ? "ok" : "warn",
        lines: [
          `root ${BLUEPRINT_DIR}`,
          `tasks ${BLUEPRINT_DIR}/tasks`,
          `graph ${dashboard.graph ? `${BLUEPRINT_DIR}/dependencies_graph.json` : "missing"}`,
          `guide ${dashboard.manifest ? `${BLUEPRINT_DIR}/integration_guide.md` : "missing"}`,
        ],
      }),
      h(StatusPanel, {
        title: "Sessions",
        status: dashboard.tuiSessions.length > 0 ? "ok" : "warn",
        lines: [
          `records ${sessionStatus}`,
          `latest ${dashboard.tuiSessions.at(-1) ?? "none"}`,
          `exports ${exportStatus}`,
        ],
      }),
    ),
    h(TaskList, { tasks: dashboard.tasks }),
    h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1 },
      h(Box, { flexDirection: "column" }, h(Text, { bold: true }, "Next"), h(Text, null, dashboard.nextAction)),
    ),
  );
}

function TaskView({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  if (dashboard.tasks.length === 0) {
    return h(
      Box,
      { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true, color: "yellow" }, "\u{1F4CB} Tasks"),
      h(Text, null, ""),
      h(Text, null, "No task handoffs generated yet."),
      h(Text, null, "Run blueprint plan to generate the task graph."),
      h(Text, null, ""),
      h(Text, { color: "cyan" }, "Tip: use --engine llm for AI-assisted planning."),
    );
  }

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(TaskList, { tasks: dashboard.tasks }),
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Task Details"),
      ...dashboard.tasks.flatMap((task) => [
        h(Text, { key: `${task.id}-model` }, `${task.id} model ${task.suggestedModel}`),
        h(Text, { key: `${task.id}-paths` }, `paths ${task.allowedPaths.join(",") || "none"}`),
      ]),
    ),
  );
}

function GraphView({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  if (!dashboard.graph || dashboard.graph.nodes.length === 0) {
    return h(
      Box,
      { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true, color: "yellow" }, "\u{1F310} Dependency Graph"),
      h(Text, null, ""),
      h(Text, null, !dashboard.graph ? "dependencies_graph.json not found." : "Graph is empty \u2014 no nodes defined yet."),
      h(Text, null, "Run blueprint plan to populate the dependency graph."),
      h(Text, null, ""),
      h(Text, { color: "cyan" }, "The graph maps task execution order and risk."),
    );
  }

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, `\u{1F310} Graph Nodes (${dashboard.graph.nodes.length})`),
      ...dashboard.graph.nodes.map((node) =>
        h(
          Text,
          { key: node.id },
          `${node.id} | risk ${node.risk_level} | depends ${node.depends_on.join(",") || "none"}`,
        ),
      ),
    ),
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, `\u{1F517} Graph Edges (${dashboard.graph.edges.length})`),
      ...(dashboard.graph.edges.length > 0
        ? dashboard.graph.edges.map((edge) => h(Text, { key: `${edge.from}-${edge.to}` }, `${edge.from} \u2192 ${edge.to}`))
        : [h(Text, { key: "none" }, "none")]),
    ),
  );
}

function ProvidersView({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  const profile = dashboard.profile.profile;

  if (!profile) {
    return h(StatusPanel, {
      title: "Profile",
      status: "error",
      lines: dashboard.profile.errors.length > 0 ? dashboard.profile.errors : ["profile.yaml is missing"],
    });
  }

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(StatusPanel, {
      title: "Planner",
      status: dashboard.profile.errors.length === 0 ? "ok" : "error",
      lines: [
        `provider ${profile.planner_provider}`,
        `model ${profile.planner_model}`,
        `pool ${summarizeModels(profile.available_models)}`,
        `registry ${profile.model_registry.source}${profile.model_registry.path ? `/${profile.model_registry.path}` : ""}`,
      ],
    }),
    h(StatusPanel, {
      title: "Provider Pool",
      status: profile.available_providers.length > 0 ? "ok" : "warn",
      lines: [
        `available ${profile.available_providers.join(",")}`,
        `excluded ${profile.excluded_providers.join(",") || "none"}`,
        `fallback ${profile.routing.allow_provider_fallback ? "enabled" : "disabled"}`,
        `confirmation ${profile.routing.require_confirmation_for_fallback ? "required" : "not_required"}`,
      ],
    }),
    h(StatusPanel, {
      title: "Model Pool",
      status: profile.available_models.length > 0 ? "ok" : "warn",
      lines: profile.available_models.length > 0 ? summarizeModelLines(profile.available_models) : ["all provider models"],
    }),
    h(StatusPanel, {
      title: "Model Catalog",
      status: dashboard.registryModels.length > 0 ? "ok" : "warn",
      lines:
        dashboard.registryModels.length > 0
          ? summarizeModelLines(dashboard.registryModels.map((model) => `${model.id} ${model.tier}/${model.status}`))
          : ["registry unavailable"],
    }),
    h(MessageList, { title: "Profile Messages", messages: [...dashboard.profile.errors, ...dashboard.profile.warnings] }),
  );
}

function ActionsView({
  dashboard,
  selectedActionIndex,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  planChatStep = "idle",
  planChatDraft = {},
  planChatInput = "",
  isEditingModelPool,
  modelPoolInput,
}: {
  dashboard: TuiDashboard;
  selectedActionIndex: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
}): React.ReactElement {
  const actions = getTuiActions(dashboard);

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Action Queue"),
      ...actions.map((action, index) =>
        h(
          Text,
          {
            key: action.id,
            color: !action.enabled ? "gray" : index === selectedActionIndex ? "cyan" : undefined,
            bold: index === selectedActionIndex,
          },
          `${index === selectedActionIndex ? ">" : " "} ${action.label} | ${action.command}${
            action.requiresConfirmation ? " | confirmation" : ""
          }${action.enabled ? "" : " | disabled"}`,
        ),
      ),
    ),
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Current Recommendation"),
      h(Text, null, dashboard.nextAction),
    ),
    h(ActionHint, {
      actions,
      selectedActionIndex,
      runningAction,
      pendingConfirmation,
      isEditingRevise,
      reviseInput,
      planChatStep,
      planChatInput,
      isEditingModelPool,
      modelPoolInput,
    }),
    ...(planChatStep !== "idle"
      ? [h(PlanChatPanel, { key: "plan-chat", planChatStep, planChatDraft, planChatInput })]
      : []),
    h(ActionResultPanel, { result: actionResult }),
  );
}

function PlanChatPanel({
  planChatStep,
  planChatDraft,
  planChatInput,
}: {
  planChatStep: Exclude<PlanChatStep, "idle">;
  planChatDraft: PlanChatDraft;
  planChatInput: string;
}): React.ReactElement {
  const completed = summarizePlanDraft(planChatDraft);

  return h(
    Box,
    { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Planning Chat"),
    ...completed.map((line) => h(Text, { key: line, color: "gray" }, line)),
    h(Text, null, `Planner: ${PLAN_STEP_PROMPTS[planChatStep]}`),
    h(Text, { color: "cyan" }, `You: ${planChatInput}`),
    h(Text, { color: "gray" }, "Enter sends the answer. Esc cancels this chat."),
  );
}

function ActionHint({
  actions,
  selectedActionIndex,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  planChatStep = "idle",
  planChatInput,
  isEditingModelPool,
  modelPoolInput,
}: {
  actions: TuiAction[];
  selectedActionIndex: number;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  planChatStep?: PlanChatStep;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
}): React.ReactElement {
  const selectedAction = actions[selectedActionIndex];
  const message = isEditingRevise
    ? `Change: ${reviseInput ?? ""}`
    : planChatStep !== "idle"
    ? `Planner chat: ${PLAN_STEP_PROMPTS[planChatStep]}: ${planChatInput ?? ""}`
    : isEditingModelPool
    ? `Models: ${modelPoolInput ?? ""}`
    : runningAction
    ? `Running ${runningAction}...`
    : pendingConfirmation
      ? `Confirm ${pendingConfirmation}? press y or n.`
      : selectedAction
        ? `${selectedAction.description} Press Enter to run.`
        : "No action selected.";

  return h(
    Box,
    {
      borderStyle: "single",
      borderColor: pendingConfirmation || isEditingRevise || isEditingModelPool || planChatStep !== "idle" ? "yellow" : "gray",
      paddingX: 1,
    },
    h(Text, null, message),
  );
}

function ActionResultPanel({ result }: { result?: TuiActionResult }): React.ReactElement | null {
  if (!result) {
    return null;
  }

  const visibleLines = result.lines.slice(0, 8);
  const hiddenCount = result.lines.length - visibleLines.length;

  return h(
    Box,
    { borderStyle: "single", borderColor: result.status === "ok" ? "green" : "red", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, `${result.actionId} ${result.status}`),
    h(Text, null, result.summary),
    ...visibleLines.map((line) => h(Text, { key: line }, line)),
    ...(hiddenCount > 0 ? [h(Text, { key: "more", color: "gray" }, `+${hiddenCount} more line(s)`)] : []),
    ...(result.sessionPath ? [h(Text, { key: "session" }, `session ${result.sessionPath}`)] : []),
  );
}

function TabBar({ activeView }: { activeView: TuiView }): React.ReactElement {
  return h(
    Box,
    { gap: 1 },
    ...TUI_VIEWS.map((view) =>
      h(
        Box,
        {
          key: view,
          borderStyle: "single",
          borderColor: view === activeView ? "cyan" : "gray",
          paddingX: 1,
        },
        h(Text, { bold: view === activeView }, view),
      ),
    ),
  );
}

function StatusPanel({
  title,
  status,
  lines,
}: {
  title: string;
  status: "ok" | "warn" | "error";
  lines: string[];
}): React.ReactElement {
  const color = status === "ok" ? "green" : status === "warn" ? "yellow" : "red";
  const icon = statusIcon(status);
  const maxLineWidth = 40; // 44 panel width minus 2x paddingX minus 2 border chars

  return h(
    Box,
    { borderStyle: "single", borderColor: color, paddingX: 1, width: 44, overflowX: "hidden" as any },
    h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true, color }, `${icon} ${title}`),
      ...lines.slice(0, 5).map((line) => h(Text, { key: line, wrap: "truncate" }, truncateLine(line, maxLineWidth))),
    ),
  );
}

function TaskList({ tasks }: { tasks: TuiTaskSummary[] }): React.ReactElement | null {
  if (tasks.length === 0) {
    return null;
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, `\u{1F4CB} Execution Graph (${tasks.length} tasks)`),
    ...tasks.map((task) =>
      h(
        Text,
        { key: task.id },
        `${riskIcon(task.riskLevel)} ${task.id} | risk ${task.riskLevel} | deps ${task.dependencies.length ? task.dependencies.join(",") : "none"} | ${task.title}`,
      ),
    ),
  );
}

function MessageList({ title, messages }: { title: string; messages: string[] }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: messages.length > 0 ? "yellow" : "green", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, title),
    ...(messages.length > 0 ? messages : ["none"]).map((message) => h(Text, { key: message }, message)),
  );
}

function EmptyPanel({ title, message }: { title: string; message: string }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, title),
    h(Text, null, message),
  );
}

async function readManifest(blueprintRoot: string): Promise<BlueprintManifest | undefined> {
  try {
    const raw = await readFile(path.join(blueprintRoot, "blueprint.yaml"), "utf8");
    return BlueprintManifestSchema.parse(parseYaml(raw));
  } catch {
    return undefined;
  }
}

async function readGraph(blueprintRoot: string): Promise<DependencyGraph | undefined> {
  try {
    const raw = await readFile(path.join(blueprintRoot, "dependencies_graph.json"), "utf8");
    return DependencyGraphSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function readTasks(blueprintRoot: string): Promise<TuiTaskSummary[]> {
  const taskFiles = await fg(["tasks/*.md", "!tasks/README.md"], {
    cwd: blueprintRoot,
    onlyFiles: true,
  });
  const tasks = await Promise.all(
    taskFiles.map(async (file) => {
      const raw = await readFile(path.join(blueprintRoot, file), "utf8");
      const parsed = matter(raw);
      const metadata = BlueprintTaskMetadataSchema.parse(parsed.data);

      return toTaskSummary(metadata);
    }),
  );

  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

async function readRegistryModels(root: string, profile: PlannerProfile): Promise<TuiModelSummary[]> {
  const result = await loadModelRegistryForProfile(root, profile);

  if (result.errors.length > 0 || !result.registry) {
    return [];
  }

  const availableProviders = new Set(profile.available_providers);

  return result.registry.models
    .filter((model) => availableProviders.has(model.provider))
    .map(toModelSummary)
    .sort((left, right) => `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`));
}

async function readExports(blueprintRoot: string): Promise<string[]> {
  try {
    const manifests = await fg(["exports/*/EXPORT_MANIFEST.json"], {
      cwd: blueprintRoot,
      onlyFiles: true,
    });

    return manifests.map((file) => path.dirname(file)).sort();
  } catch {
    return [];
  }
}

async function readTuiSessions(blueprintRoot: string): Promise<string[]> {
  try {
    return await fg(["tui_sessions/*.json"], {
      cwd: blueprintRoot,
      onlyFiles: true,
    });
  } catch {
    return [];
  }
}

function toTaskSummary(metadata: BlueprintTaskMetadata): TuiTaskSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    suggestedModel: metadata.suggested_model,
    dependencies: metadata.dependencies,
    allowedPaths: metadata.allowed_paths,
    riskLevel: metadata.risk_level,
  };
}

function toModelSummary(model: ModelRegistryEntry): TuiModelSummary {
  return {
    id: model.id,
    provider: model.provider,
    tier: model.tier,
    status: model.status,
  };
}

function inferNextAction(input: {
  setup: TuiSetupStatus;
  profile: PlannerProfileValidationResult;
  lint: BlueprintLintResult;
  tasks: TuiTaskSummary[];
  manifest?: BlueprintManifest;
}): string {
  if (!input.setup.initialized) {
    return "Start onboarding in the TUI to configure directory, providers, models, and planner.";
  }

  if (input.profile.errors.length > 0 || !input.profile.profile) {
    return "Run blueprint profile init or blueprint profile validate.";
  }

  if (!input.manifest || input.tasks.length === 0) {
    return "Run blueprint plan to generate architecture, graph, and task handoffs.";
  }

  if (input.lint.errors.length > 0) {
    return "Run blueprint lint and fix the reported artifact errors.";
  }

  return "Run blueprint export, or use blueprint revise for a targeted plan update.";
}

async function inspectBlueprintSetup(root: string, blueprintRoot: string): Promise<TuiSetupStatus> {
  try {
    const info = await stat(blueprintRoot);

    if (info.isDirectory()) {
      return {
        initialized: true,
        messages: [],
        commands: [],
      };
    }
  } catch {
    // Missing .blueprint is handled by the onboarding state below.
  }

  return {
    initialized: false,
    messages: [
      `Current directory: ${root}`,
      "This directory has no .blueprint folder yet.",
      "Open the project root or initialize the harness here.",
      "Press Enter in this screen to start onboarding.",
      "Press c to choose another directory.",
    ],
    commands: [
      "blueprint",
      "blueprint --view actions",
    ],
  };
}

function updatePlanChatDraft(
  draft: PlanChatDraft,
  step: Exclude<PlanChatStep, "idle">,
  value: string,
): PlanChatDraft | undefined {
  if (step === "projectSummary" || step === "objective") {
    if (value.length === 0) {
      return undefined;
    }

    return { ...draft, [step]: value };
  }

  if (step === "riskLevel") {
    const parsed = Number(value || "5");

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      return undefined;
    }

    return { ...draft, riskLevel: parsed };
  }

  const items = parsePlanListInput(value);

  if (step === "successCriteria" && items.length === 0) {
    return undefined;
  }

  return { ...draft, [step]: items };
}

function nextPlanChatStep(step: Exclude<PlanChatStep, "idle">): Exclude<PlanChatStep, "idle"> | undefined {
  const index = PLAN_CHAT_STEPS.indexOf(step);
  return PLAN_CHAT_STEPS[index + 1];
}

function buildPlanAnswersFromDraft(draft: PlanChatDraft): PlanAnswers {
  return {
    projectSummary: draft.projectSummary ?? "",
    objective: draft.objective ?? "",
    successCriteria: draft.successCriteria ?? [],
    constraints: draft.constraints ?? [],
    outOfScope: draft.outOfScope ?? [],
    targetPaths: draft.targetPaths ?? [],
    validationCommands: draft.validationCommands ?? [],
    riskLevel: draft.riskLevel ?? 5,
    notes: draft.notes ?? [],
  };
}

function parsePlanListInput(value: string): string[] {
  return value
    .split(/[,;\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function planChatValidationMessage(step: Exclude<PlanChatStep, "idle">): string {
  if (step === "riskLevel") {
    return "Risk must be an integer from 1 to 10.";
  }

  if (step === "successCriteria") {
    return "At least one success criterion is required.";
  }

  return "This answer is required.";
}

function summarizePlanDraft(draft: PlanChatDraft): string[] {
  const lines: string[] = [];

  if (draft.projectSummary) {
    lines.push(`Project: ${draft.projectSummary}`);
  }

  if (draft.objective) {
    lines.push(`Objective: ${draft.objective}`);
  }

  if (draft.successCriteria) {
    lines.push(`Success: ${summarizeList(draft.successCriteria, 2)}`);
  }

  if (draft.targetPaths && draft.targetPaths.length > 0) {
    lines.push(`Paths: ${summarizeList(draft.targetPaths, 2)}`);
  }

  if (draft.validationCommands && draft.validationCommands.length > 0) {
    lines.push(`Validation: ${summarizeList(draft.validationCommands, 2)}`);
  }

  if (draft.riskLevel) {
    lines.push(`Risk: ${draft.riskLevel}`);
  }

  return lines;
}

function resolveUserRoot(input: string, currentRoot: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return currentRoot;
  }

  const expanded =
    trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;

  return path.resolve(currentRoot, expanded);
}

function parseTuiModelPoolInput(input: string): string[] | undefined {
  if (/^(all|default|reset)$/iu.test(input.trim())) {
    return undefined;
  }

  return parseModelIds(input);
}

function nextView(view: TuiView): TuiView {
  const index = TUI_VIEWS.indexOf(view);
  return TUI_VIEWS[(index + 1) % TUI_VIEWS.length]!;
}

function previousView(view: TuiView): TuiView {
  const index = TUI_VIEWS.indexOf(view);
  return TUI_VIEWS[(index - 1 + TUI_VIEWS.length) % TUI_VIEWS.length]!;
}

async function writeTuiSessionRecord(options: RunTuiActionOptions, result: TuiActionResult): Promise<string> {
  const root = path.resolve(options.root);
  const createdAt = new Date().toISOString();
  const sessionId = randomUUID();
  const record = TuiSessionRecordSchema.parse({
    schema_version: "1.0",
    session_id: sessionId,
    created_at: createdAt,
    root,
    action: {
      id: options.actionId,
      command: commandForAction(options.actionId),
      change: options.change?.trim() || options.modelPool?.trim() || undefined,
      apply: Boolean(options.apply),
    },
    result: {
      status: result.status,
      summary: result.summary,
      lines: result.lines,
      can_apply: result.canApply,
    },
  });
  const sessionsRoot = path.join(root, BLUEPRINT_DIR, "tui_sessions");
  const filename = `${createdAt.replace(/[:.]/gu, "-")}-${options.actionId}-${sessionId.slice(0, 8)}.json`;
  const targetPath = path.join(sessionsRoot, filename);

  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return targetPath;
}

function commandForAction(actionId: TuiActionId): string {
  if (actionId === "setup") {
    return "blueprint init + profile init";
  }

  if (actionId === "plan") {
    return "blueprint plan";
  }

  if (actionId === "lint") {
    return "blueprint lint";
  }

  if (actionId === "model-pool") {
    return 'profile available_models "<ids|all>"';
  }

  if (actionId === "registry-refresh") {
    return "blueprint registry refresh";
  }

  if (actionId === "export") {
    return "blueprint export";
  }

  if (actionId === "revise") {
    return 'blueprint revise --change "<text>"';
  }

  if (actionId === "auth-doctor-live") {
    return "blueprint auth doctor --live";
  }

  return "blueprint auth doctor";
}

function formatExportActionResult(actionId: TuiActionId, result: ExportBlueprintResult): TuiActionResult {
  return {
    actionId,
    status: "ok",
    summary: `Exported ${result.manifest.included_files.length} file(s).`,
    lines: [`output ${result.outputPath}`, `manifest ${result.manifestPath}`],
  };
}

function formatReviseActionResult(
  actionId: TuiActionId,
  result: ReviseResult,
  change: string,
  applied: boolean,
): TuiActionResult {
  const application = result.plan.application;
  const status = applied && (application.status === "failed" || application.status === "unsupported") ? "failed" : "ok";
  const applySafeClasses = new Set(["local_doc", "task_local", "graph_local"]);
  const canApply = !applied && applySafeClasses.has(result.plan.classification);
  const lines = [
    `classification ${result.plan.classification}`,
    `confidence ${result.plan.confidence}`,
    `affected_files ${result.plan.affected_files.join(",") || "none"}`,
    `affected_tasks ${result.plan.affected_tasks.join(",") || "none"}`,
    `recommended_action ${result.plan.recommended_action}`,
  ];

  if (applied) {
    lines.push(`application ${application.status}`);
  } else if (canApply) {
    lines.push("apply available after confirmation");
  } else {
    lines.push("apply blocked for this classification");
  }

  if (application.target_file) {
    lines.push(`target ${application.target_file}`);
  }

  if (application.summary) {
    lines.push(`summary ${application.summary}`);
  }

  if (application.error) {
    lines.push(`error ${application.error}`);
  }

  if (result.writtenPath) {
    lines.push(`revision ${result.writtenPath}`);
  }

  if (result.appliedPath) {
    lines.push(`applied ${result.appliedPath}`);
  }

  return {
    actionId,
    status,
    summary: applied
      ? `Revise apply ${application.status} for ${result.plan.classification}.`
      : `Revise preview classified as ${result.plan.classification}.`,
    lines,
    canApply,
    change,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function truncateLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) {
    return line;
  }

  return `${line.slice(0, maxWidth - 1)}…`;
}

function summarizeList(items: string[], maxVisible: number): string {
  if (items.length === 0) {
    return "none";
  }

  if (items.length <= maxVisible) {
    return items.join(",");
  }

  return `${items.slice(0, maxVisible).join(",")}… +${items.length - maxVisible} more`;
}

function summarizeModels(models: string[]): string {
  if (models.length === 0) {
    return "all-provider-models";
  }

  return summarizeList(models, 3);
}

function summarizeModelLines(models: string[]): string[] {
  if (models.length <= 4) {
    return models;
  }

  return [...models.slice(0, 4), `+${models.length - 4} more`];
}

function summarizeManifests(manifests: string[]): string {
  if (manifests.length === 0) {
    return "none";
  }

  if (manifests.length <= 3) {
    const short = manifests.map((m) => path.basename(m));
    return `${manifests.length} (${short.join(", ")})`;
  }

  return `${manifests.length} found`;
}

function statusIcon(status: "ok" | "warn" | "error"): string {
  if (status === "ok") {
    return "\u2705";
  }

  if (status === "warn") {
    return "\u26A0\uFE0F";
  }

  return "\u274C";
}

function riskIcon(riskLevel: number): string {
  if (riskLevel >= 7) {
    return "\u{1F534}";
  }

  if (riskLevel >= 4) {
    return "\u{1F7E1}";
  }

  return "\u{1F7E2}";
}

function KeyHints({
  view,
  setupInitialized,
  pendingConfirmation,
  isEditingRevise,
  planChatStep = "idle",
  isEditingModelPool,
  isEditingRoot,
  runningAction,
  setupStep = "idle",
}: {
  view: TuiView;
  setupInitialized: boolean;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  planChatStep?: PlanChatStep;
  isEditingModelPool?: boolean;
  isEditingRoot?: boolean;
  runningAction?: TuiActionId;
  setupStep?: SetupStep;
}): React.ReactElement {
  let hints: string;

  if (isEditingRoot) {
    hints = "Enter \u2192 open dir  \u2502  Esc \u2192 cancel";
  } else if (!setupInitialized && setupStep !== "idle") {
    hints = "Space \u2192 toggle  \u2502  Enter \u2192 next  \u2502  b \u2192 back  \u2502  Esc \u2192 cancel";
  } else if (planChatStep !== "idle" || isEditingRevise || isEditingModelPool) {
    hints = "Enter \u2192 submit  \u2502  Esc \u2192 cancel";
  } else if (pendingConfirmation) {
    hints = "y \u2192 confirm  \u2502  n \u2192 cancel";
  } else if (runningAction) {
    hints = `Running ${runningAction}...`;
  } else if (!setupInitialized) {
    hints = "1/Enter \u2192 use current  \u2502  2 \u2192 new folder  \u2502  3/c \u2192 choose dir  \u2502  q quit";
  } else if (view === "actions") {
    hints = "\u2190\u2192 tab  \u2502  \u2191\u2193 select  \u2502  Enter run  \u2502  c dir  \u2502  q quit";
  } else {
    hints = "\u2190\u2192 tab  \u2502  1-5 jump  \u2502  c dir  \u2502  q quit";
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1 },
    h(Text, { color: "gray" }, hints),
  );
}
