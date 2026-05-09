import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import { Box, Text, render, renderToString, useApp, useInput, useWindowSize } from "ink";
import React, { createElement, useState } from "react";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { OpenCodeLogo } from "./ui/logo.js";
import { ActionResultPanel, SlashCommandPanel, ChatModelSelectorPanel, FocusOverlay, MessageList, EmptyPanel } from "./ui/panels.js";
import { LandingSurface } from "./ui/startScreen.js";
import { WorkbenchSurface } from "./ui/workbench.js";

import { BLUEPRINT_DIR, initBlueprint } from "./blueprint.js";
import { inspectProject, type ProjectDoctorReport } from "./doctor.js";
import { exportBlueprint, type ExportBlueprintResult } from "./export.js";
import { lintBlueprint, type BlueprintLintResult } from "./lint.js";
import { DEFAULT_MODEL_REGISTRY } from "./models.js";
import { runLlmPlannerEngine, type PlannerPromptRunner } from "./plannerEngine.js";
import { extractJsonObject } from "./providerPrompt.js";
import {
  generateBlueprintPlan,
  getPlannerFallbackCandidatesForRoot,
  parsePlanAnswers,
  PlannerDraftSchema,
  previewBlueprintPlan,
  type PlanAnswers,
  type PlanEngine,
} from "./plan.js";
import {
  initPlannerProfile,
  loadPlannerProfile,
  parseModelIds,
  updatePlannerProfileModels,
  updatePlannerProfilePlannerModel,
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
  ProviderIdSchema,
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
  defaultReasoningEffort?: string;
}

export interface TuiSetupStatus {
  initialized: boolean;
  messages: string[];
  commands: string[];
  providerChecks: ProviderDoctorResult[];
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
  chatDraft?: PlanChatDraft;
  agentSession?: PlannerAgentSession;
  agentState?: PlannerAgentWorkflowState;
  nextAction: string;
}

export const TUI_ACTION_IDS = [
  "setup",
  "agent-workflow",
  "plan",
  "model-pool",
  "planner-model",
  "registry-refresh",
  "lint",
  "export",
  "revise",
  "auth-doctor",
  "auth-doctor-live",
] as const;
export type TuiActionId = (typeof TUI_ACTION_IDS)[number];
type TuiLocalResultId = "help" | "providers" | "sessions";
type TuiActionResultId = TuiActionId | TuiLocalResultId;

type SetupStep = "idle" | "providers" | "models" | "reasoning" | "planner" | "confirm";

interface SetupDraft {
  providers: ProviderId[];
  models: string[];
  reasoningEfforts: Record<string, string>;
  plannerModel?: string;
}

export type PlanChatStep =
  | "idle"
  | "brief"
  | "projectSummary"
  | "objective"
  | "successCriteria"
  | "constraints"
  | "outOfScope"
  | "targetPaths"
  | "validationCommands"
  | "riskLevel"
  | "notes";

export interface PlanChatDraft {
  brief?: string;
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

export const PlannerAgentWorkflowStateSchema = z.object({
  schema_version: z.literal("1.0"),
  user_request: z.string().min(1),
  planner: z.object({
    provider: ProviderIdSchema,
    model: z.string().min(1),
    reasoning_effort: z.string().min(1).optional(),
  }),
  project_state: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    current_phase: z.string().min(1),
    health: z.enum(["planning", "needs_input", "ready_to_preview", "blocked"]).default("planning"),
    confidence: z.number().min(0).max(1).default(0.5),
  }),
  messages: z.array(z.object({
    role: z.enum(["planner"]),
    content: z.string().min(1),
  })).default([]),
  checklist: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["pending", "in_progress", "done", "blocked"]),
    validated_by: z.string().min(1).optional(),
    evidence: z.string().min(1).optional(),
    interactive: z.boolean().default(true),
  })).default([]),
  questions: z.array(z.object({
    id: z.string().min(1),
    question: z.string().min(1),
    why: z.string().min(1).optional(),
    required: z.boolean().default(true),
  })).default([]),
  next_action: z.object({
    type: z.enum(["ask_user", "continue_planning", "preview_plan"]),
    label: z.string().min(1),
    prompt: z.string().min(1).optional(),
  }),
  plan_answers: z.any().optional(),
});

export type PlannerAgentWorkflowState = z.infer<typeof PlannerAgentWorkflowStateSchema>;

export const PlannerAgentSessionSchema = z.object({
  schema_version: z.literal("1.0"),
  session_id: z.string().min(1),
  updated_at: z.iso.datetime(),
  messages: z.array(z.object({
    role: z.enum(["user", "planner"]),
    content: z.string().min(1),
    created_at: z.iso.datetime(),
  })).default([]),
  agent_state: PlannerAgentWorkflowStateSchema.optional(),
});

export type PlannerAgentSession = z.infer<typeof PlannerAgentSessionSchema>;

export const TUI_SLASH_COMMANDS = [
  {
    command: "/plan",
    usage: "/plan [brief]",
    description: "start planning chat from free text",
  },
  {
    command: "/providers",
    usage: "/providers",
    description: "show active providers, planner, and model pool",
  },
  {
    command: "/model",
    usage: "/model [id]",
    description: "switch the chat/planner model",
  },
  {
    command: "/models",
    usage: "/models <ids|all>",
    description: "update or reset the active model pool",
  },
  {
    command: "/registry",
    usage: "/registry",
    description: "confirm and refresh the project model registry",
  },
  {
    command: "/lint",
    usage: "/lint",
    description: "validate generated blueprint artifacts",
  },
  {
    command: "/export",
    usage: "/export",
    description: "export generated handoffs",
  },
  {
    command: "/revise",
    usage: "/revise <change>",
    description: "preview a targeted artifact revision",
  },
  {
    command: "/auth",
    usage: "/auth",
    description: "check local provider CLIs without model calls",
  },
  {
    command: "/auth-live",
    usage: "/auth-live",
    description: "confirm and run provider smoke checks",
  },
  {
    command: "/help",
    usage: "/help",
    description: "show local slash commands",
  },
  {
    command: "/menu",
    usage: "/menu",
    description: "return to the main menu",
  },
  {
    command: "/resume",
    usage: "/resume",
    description: "resume the last planning draft if one exists",
  },
  {
    command: "/sessions",
    usage: "/sessions",
    description: "show saved planning session metadata",
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "clear the saved planning session and return to landing",
  },
] as const;

type TuiSlashCommand = (typeof TUI_SLASH_COMMANDS)[number]["command"];

export interface ParsedTuiSlashCommand {
  command: TuiSlashCommand;
  argument: string;
}

const SETUP_PROVIDER_OPTIONS = ["openai", "anthropic", "google"] as const satisfies readonly ProviderId[];
const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  openai: "OPENAI",
  anthropic: "ANTHROPIC",
  google: "GOOGLE",
};
const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI / Codex",
  anthropic: "Anthropic / Claude Code",
  google: "Google / Gemini",
};

const PLAN_CHAT_STEPS = [
  "brief",
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

export const PLAN_STEP_PROMPTS: Record<Exclude<PlanChatStep, "idle">, string> = {
  brief: "Conte livremente o que vamos planejar agora",
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
  actionId: TuiActionResultId;
  status: "ok" | "failed" | "needs-confirmation";
  summary: string;
  lines: string[];
  agentState?: PlannerAgentWorkflowState;
  planAnswers?: PlanAnswers;
  canApply?: boolean;
  change?: string;
  planContinuation?: PlanContinuation;
  sessionPath?: string;
}

interface PlanContinuation {
  type: "preview" | "apply" | "fallback";
  engine: PlanEngine;
  plannerProvider?: ProviderId;
  plannerModel?: string;
  force?: boolean;
  attemptedModels?: string[];
}

export interface RunTuiActionOptions {
  root: string;
  actionId: TuiActionId;
  change?: string;
  modelPool?: string;
  agentRequest?: string;
  planAnswers?: PlanAnswers;
  planEngine?: PlanEngine;
  planForce?: boolean;
  planAttemptedModels?: string[];
  plannerPromptRunner?: PlannerPromptRunner;
  providers?: ProviderId[];
  models?: string[];
  modelReasoningEfforts?: Record<string, string>;
  plannerProvider?: ProviderId;
  plannerModel?: string;
  plannerReasoningEffort?: string;
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
    plan_answers: z.any().optional(),
  }),
  result: z.object({
    status: z.enum(["ok", "failed", "needs-confirmation"]),
    summary: z.string().min(1),
    lines: z.array(z.string()),
    can_apply: z.boolean().optional(),
  }),
});

export type TuiSessionRecord = z.infer<typeof TuiSessionRecordSchema>;

const TuiPlanPreviewCacheSchema = z.object({
  schema_version: z.literal("1.0"),
  created_at: z.iso.datetime(),
  engine: z.enum(["deterministic", "llm"]),
  planner_provider: ProviderIdSchema,
  planner_model: z.string().min(1),
  force: z.boolean().default(false),
  plan_answers: z.any(),
  draft: PlannerDraftSchema.optional(),
});

type TuiPlanPreviewCache = z.infer<typeof TuiPlanPreviewCacheSchema>;

export const TUI_SECTION_VIEWS = ["overview", "tasks", "graph", "providers", "actions"] as const;
export const TUI_VIEWS = ["main", ...TUI_SECTION_VIEWS] as const;
const TUI_MAIN_MENU_ITEMS = [
  {
    view: "actions",
    label: "Plan / Actions",
    description: "Planner chat, revise, lint, export, and auth checks.",
  },
  {
    view: "overview",
    label: "Overview",
    description: "Operational health, project context, artifacts, and next action.",
  },
  {
    view: "tasks",
    label: "Tasks",
    description: "Generated worker handoffs and model assignments.",
  },
  {
    view: "graph",
    label: "Dependency Graph",
    description: "Execution order, blockers, and task dependencies.",
  },
  {
    view: "providers",
    label: "Providers / Models",
    description: "Planner provider, model pool, fallback policy, and registry.",
  },
] as const satisfies readonly {
  view: (typeof TUI_SECTION_VIEWS)[number];
  label: string;
  description: string;
}[];
export type TuiView = (typeof TUI_VIEWS)[number];
type TuiSectionView = (typeof TUI_SECTION_VIEWS)[number];
type TuiMainMenuItem = (typeof TUI_MAIN_MENU_ITEMS)[number];

const h = createElement;
export const TUI_APP_NAME = "blueprint";
export const TUI_APP_VERSION = "0.0.0";
export const TUI_SLASH_MENU_VISIBLE_ROWS = 6;
export const TUI_MODEL_SELECTOR_VISIBLE_ROWS = 8;
const TUI_AGENT_SESSION_FILE = "SESSION.json";
const PLANNER_CONTEXT_MANIFEST_LIMIT = 40;
const PLANNER_CONTEXT_INVENTORY_LIMIT = 60;
const PLANNER_CONTEXT_LINT_LIMIT = 20;
const TUI_AGENT_STATE_FILE = "AGENT_STATE.json";
const TUI_PLAN_PREVIEW_FILE = "PLAN_PREVIEW.json";

export async function loadTuiDashboard(options: TuiDashboardOptions): Promise<TuiDashboard> {
  const root = path.resolve(options.root);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  let [
    setup,
    profile,
    doctor,
    lint,
    manifest,
    graph,
    tasks,
    exports,
    tuiSessions,
    chatDraftRaw,
    agentSessionRaw,
    agentStateRaw,
  ] = await Promise.all([
    inspectBlueprintSetup(root, blueprintRoot),
    loadPlannerProfile(root),
    inspectProject(root),
    lintBlueprint(root),
    readManifest(blueprintRoot),
    readGraph(blueprintRoot),
    readTasks(blueprintRoot),
    readExports(blueprintRoot),
    readTuiSessions(blueprintRoot),
    readFile(path.join(blueprintRoot, "tui_sessions", "DRAFT.json"), "utf8").catch(() => undefined),
    readFile(path.join(blueprintRoot, "tui_sessions", TUI_AGENT_SESSION_FILE), "utf8").catch(() => undefined),
    readFile(path.join(blueprintRoot, "tui_sessions", TUI_AGENT_STATE_FILE), "utf8").catch(() => undefined),
  ]);
  if (!setup.initialized) {
    setup = {
      ...setup,
      providerChecks: await Promise.all(DEFAULT_PROVIDER_ADAPTERS.map((adapter) => checkProviderAuth(adapter))),
    };
  }
  const registryModels = profile.profile ? await readRegistryModels(root, profile.profile) : [];

  let chatDraft: PlanChatDraft | undefined;
  if (chatDraftRaw) {
    try {
      chatDraft = JSON.parse(chatDraftRaw);
    } catch {
      // Ignore parse errors
    }
  }
  let agentSession: PlannerAgentSession | undefined;
  if (agentSessionRaw) {
    try {
      agentSession = PlannerAgentSessionSchema.parse(JSON.parse(agentSessionRaw));
    } catch {
      // Ignore parse errors
    }
  }
  let agentState: PlannerAgentWorkflowState | undefined = agentSession?.agent_state;
  if (agentStateRaw) {
    try {
      agentState ??= PlannerAgentWorkflowStateSchema.parse(JSON.parse(agentStateRaw));
    } catch {
      // Ignore parse errors
    }
  }

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
    chatDraft,
    agentSession,
    agentState,
    nextAction: inferNextAction({ setup, profile, lint, tasks, manifest }),
  };
}

export async function runTuiDashboard(options: TuiDashboardOptions): Promise<void> {
  const dashboard = await loadTuiDashboard(options);
  const view = options.initialView ?? "actions";

  if (!process.stdout.isTTY) {
    console.log(renderTuiDashboardToString(dashboard, view));
    return;
  }

  const element = h(InteractiveDashboard, { dashboard, initialView: view });
  const instance = render(element, {
    exitOnCtrlC: true,
    interactive: true,
    alternateScreen: true,
  });

  await instance.waitUntilExit();
}

export function renderTuiDashboardToString(dashboard: TuiDashboard, view: TuiView = "actions"): string {
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
      id: "agent-workflow",
      label: "Start Agent Workflow",
      command: "planner agent workflow",
      description: "Send the first message to the active planner model and render its workflow state.",
      enabled: profileReady,
      requiresConfirmation: false,
      requiresInput: true,
    },
    {
      id: "plan",
      label: "Preview Handoffs",
      command: "blueprint plan",
      description: "Preview task-model assignments, then write handoffs.",
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
      id: "planner-model",
      label: "Switch Chat Model",
      command: 'profile planner_model "<id>"',
      description: "Change the model used by the interactive planning chat.",
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

  if (options.actionId === "agent-workflow") {
    return runAgentWorkflowTuiAction(options);
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

  if (options.actionId === "planner-model") {
    const plannerModel = options.plannerModel?.trim();

    if (!plannerModel) {
      return {
        actionId: options.actionId,
        status: "failed",
        summary: "Missing planner model.",
        lines: ["Choose a model from the selector, or run /model <id>."],
      };
    }

    const result = await updatePlannerProfilePlannerModel({
      root: options.root,
      plannerModel,
      plannerReasoningEffort: options.plannerReasoningEffort,
    });

    return {
      actionId: options.actionId,
      status: "ok",
      summary: `Chat model switched to ${result.profile.planner_model}.`,
      lines: [
        `planner ${result.profile.planner_provider}/${result.profile.planner_model}`,
        `reasoning ${result.profile.planner_reasoning_effort ?? "default"}`,
        `models ${result.profile.available_models.join(",") || "all provider defaults"}`,
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

async function runAgentWorkflowTuiAction(options: RunTuiActionOptions): Promise<TuiActionResult> {
  const request = options.agentRequest?.trim();

  if (!request) {
    return {
      actionId: "agent-workflow",
      status: "failed",
      summary: "Missing planner request.",
      lines: ["Type the project request in the chat so the active planner model can build the workflow state."],
    };
  }

  const dashboard = await loadTuiDashboard({ root: options.root });
  const profile = dashboard.profile.profile;

  if (!profile || dashboard.profile.errors.length > 0) {
    return {
      actionId: "agent-workflow",
      status: "failed",
      summary: "Planner profile is not ready.",
      lines: [...dashboard.profile.errors, "Run onboarding before starting the agentic workflow."],
    };
  }

  const registryResult = await loadModelRegistryForProfile(options.root, profile);
  const registry = registryResult.registry?.models ?? DEFAULT_MODEL_REGISTRY;
  const requestedPlannerModel = options.plannerModel
    ? registry.find((model) => model.id === options.plannerModel)
    : undefined;
  const plannerProvider = requestedPlannerModel?.provider ?? options.plannerProvider ?? profile.planner_provider;
  const plannerModel = requestedPlannerModel?.id ?? options.plannerModel ?? profile.planner_model;
  const plannerRegistryModel = registry.find((model) => model.id === plannerModel);
  const reasoningEffort =
    (plannerModel === profile.planner_model ? profile.planner_reasoning_effort : undefined)
    ?? profile.model_reasoning_efforts[plannerModel]
    ?? plannerRegistryModel?.default_reasoning_effort;
  const prompt = buildPlannerAgentWorkflowPrompt({
    request,
    dashboard,
    profile,
    registry,
    reasoningEffort,
  });
  let result: Awaited<ReturnType<typeof runLlmPlannerEngine<PlannerAgentWorkflowState>>>;

  try {
    result = await runLlmPlannerEngine({
      provider: plannerProvider,
      model: plannerModel,
      reasoningEffort,
      prompt,
      parseDraft: parsePlannerAgentWorkflowState,
      runner: options.plannerPromptRunner,
      timeoutMs: options.liveTimeoutMs,
    });
  } catch (error) {
    return buildAgentWorkflowFallbackResult(options, error, plannerModel, request);
  }

  const state = PlannerAgentWorkflowStateSchema.parse({
    ...result.draft,
    user_request: result.draft.user_request || request,
    planner: {
      ...result.draft.planner,
      provider: plannerProvider,
      model: plannerModel,
      reasoning_effort: reasoningEffort,
    },
  });
  const planAnswers = parseWorkflowPlanAnswers(state);

  await writePlannerAgentSession(options.root, dashboard.agentSession, request, state);

  return {
    actionId: "agent-workflow",
    status: "ok",
    summary: `${state.project_state.current_phase}: ${state.project_state.summary}`,
    agentState: state,
    planAnswers,
    canApply: Boolean(planAnswers && state.next_action.type === "preview_plan"),
    planContinuation:
      planAnswers && state.next_action.type === "preview_plan"
        ? {
            type: "preview",
            engine: "llm",
            plannerProvider: state.planner.provider,
            plannerModel: state.planner.model,
            force: dashboard.tasks.length > 0,
          }
        : undefined,
    lines: [
      `planner ${state.planner.provider}/${state.planner.model}`,
      `reasoning ${state.planner.reasoning_effort ?? "default"}`,
      `health ${state.project_state.health}`,
      `confidence ${state.project_state.confidence.toFixed(2)}`,
      ...state.checklist.map((item) => `check ${item.status} ${item.id} ${item.label}`),
      ...state.questions.map((question) => `question ${question.id} ${question.question}`),
      `next ${state.next_action.type} ${state.next_action.label}`,
    ],
  };
}

async function buildAgentWorkflowFallbackResult(
  options: RunTuiActionOptions,
  error: unknown,
  failedModel: string | undefined,
  request: string,
): Promise<TuiActionResult> {
  const attemptedModels = uniqueStrings([
    ...(options.planAttemptedModels ?? []),
    ...(failedModel ? [failedModel] : []),
  ]);
  const candidates = (
    await getPlannerFallbackCandidatesForRoot({
      root: options.root,
      failedModel,
    })
  ).filter((candidate) => !attemptedModels.includes(candidate.model));
  const message = summarizeTuiError(error);

  if (candidates.length > 0) {
    const next = candidates[0]!;

    return {
      actionId: "agent-workflow",
      status: "needs-confirmation",
      summary: `Planner fallback ready: ${next.provider}/${next.model}.`,
      canApply: true,
      planContinuation: {
        type: "fallback",
        engine: "llm",
        plannerProvider: next.provider,
        plannerModel: next.model,
        attemptedModels,
      },
      lines: [
        `request ${request}`,
        `primary_error ${message}`,
        `failed_model ${failedModel ?? "unknown"}`,
        `fallback ${next.provider}/${next.model}`,
        `reason ${next.reason}`,
        "press y to try this fallback or n to cancel",
      ],
    };
  }

  return {
    actionId: "agent-workflow",
    status: "failed",
    summary: `Planner ${failedModel ?? "LLM"} failed. No workflow fallback is available.`,
    lines: [
      `request ${request}`,
      `error ${message}`,
      `failed_model ${failedModel ?? "unknown"}`,
    ],
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
    let preview: Awaited<ReturnType<typeof previewBlueprintPlan>>;

    try {
      preview = await previewBlueprintPlan({
        root: options.root,
        answers: options.planAnswers,
        engine,
        plannerProvider: options.plannerProvider,
        plannerModel: options.plannerModel,
        plannerPromptRunner: options.plannerPromptRunner,
        force,
      });
    } catch (error) {
      if (engine !== "llm") {
        throw error;
      }

      return buildPlanTuiFallbackResult(options, error, force);
    }
    const attemptedModels = uniqueStrings([
      ...(options.planAttemptedModels ?? []),
      preview.plannerModel,
    ]);

    await writePlanPreviewCache({
      root: options.root,
      preview,
      planAnswers: options.planAnswers,
      force,
    });

    return {
      actionId: "plan",
      status: "ok",
      summary: `Plan preview ready with ${preview.tasks.length} task(s).`,
      canApply: true,
      planContinuation: {
        type: "apply",
        engine: preview.engine,
        plannerProvider: preview.plannerProvider,
        plannerModel: preview.plannerModel,
        force,
        attemptedModels,
      },
      lines: [
        `engine ${preview.engine}`,
        `planner ${preview.plannerProvider}/${preview.plannerModel}${preview.plannerFallback ? " fallback" : ""}`,
        `overview ${preview.overview}`,
        ...preview.tasks.map((task) => {
          const deps = task.dependencies.length > 0 ? task.dependencies.join(",") : "none";
          const paths = task.allowedPaths.length > 0 ? task.allowedPaths.join(",") : "read-only";
          const alternatives =
            task.acceptableAlternatives.length > 0 ? task.acceptableAlternatives.join(",") : "none";
          return `${task.id} model ${task.suggestedModel} risk ${task.riskLevel} deps ${deps} paths ${paths} alternatives ${alternatives} reason ${task.modelRationale}`;
        }),
        force ? "warning existing generated tasks will be replaced after confirmation" : "write pending confirmation",
      ],
    };
  }

  const previewCache = await readMatchingPlanPreviewCache({
    root: options.root,
    planAnswers: options.planAnswers,
    engine,
    plannerProvider: options.plannerProvider,
    plannerModel: options.plannerModel,
    force,
  });
  const result = await generateBlueprintPlan({
    root: options.root,
    answers: options.planAnswers,
    engine,
    plannerProvider: options.plannerProvider ?? previewCache?.planner_provider,
    plannerModel: options.plannerModel ?? previewCache?.planner_model,
    draft: previewCache?.draft,
    plannerPromptRunner: options.plannerPromptRunner,
    force,
  });
  const lint = await lintBlueprint(options.root);

  if (lint.errors.length === 0) {
    await clearPlanPreviewCache(options.root);
  }

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

async function writePlanPreviewCache(options: {
  root: string;
  preview: Awaited<ReturnType<typeof previewBlueprintPlan>>;
  planAnswers: PlanAnswers;
  force: boolean;
}): Promise<void> {
  if (!options.preview.draft) {
    return;
  }

  const sessionsRoot = path.join(path.resolve(options.root), BLUEPRINT_DIR, "tui_sessions");
  const cache = TuiPlanPreviewCacheSchema.parse({
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    engine: options.preview.engine,
    planner_provider: options.preview.plannerProvider,
    planner_model: options.preview.plannerModel,
    force: options.force,
    plan_answers: options.planAnswers,
    draft: options.preview.draft,
  });

  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(path.join(sessionsRoot, TUI_PLAN_PREVIEW_FILE), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function readMatchingPlanPreviewCache(options: {
  root: string;
  planAnswers: PlanAnswers;
  engine: PlanEngine;
  plannerProvider?: ProviderId;
  plannerModel?: string;
  force: boolean;
}): Promise<TuiPlanPreviewCache | undefined> {
  const cachePath = path.join(path.resolve(options.root), BLUEPRINT_DIR, "tui_sessions", TUI_PLAN_PREVIEW_FILE);

  try {
    const raw = await readFile(cachePath, "utf8");
    const cache = TuiPlanPreviewCacheSchema.parse(JSON.parse(raw));
    const cachedAnswers = parsePlanAnswers(cache.plan_answers);

    if (cache.engine !== options.engine || cache.force !== options.force) {
      return undefined;
    }

    if (options.plannerProvider && cache.planner_provider !== options.plannerProvider) {
      return undefined;
    }

    if (options.plannerModel && cache.planner_model !== options.plannerModel) {
      return undefined;
    }

    if (JSON.stringify(cachedAnswers) !== JSON.stringify(options.planAnswers)) {
      return undefined;
    }

    return cache;
  } catch {
    return undefined;
  }
}

async function clearPlanPreviewCache(rootInput: string): Promise<void> {
  await rm(path.join(path.resolve(rootInput), BLUEPRINT_DIR, "tui_sessions", TUI_PLAN_PREVIEW_FILE), { force: true });
}

async function buildPlanTuiFallbackResult(
  options: RunTuiActionOptions,
  error: unknown,
  force: boolean,
): Promise<TuiActionResult> {
  const profile = await loadPlannerProfile(options.root);
  const failedModel = options.plannerModel ?? profile.profile?.planner_model;
  const attemptedModels = uniqueStrings([
    ...(options.planAttemptedModels ?? []),
    ...(failedModel ? [failedModel] : []),
  ]);
  const candidates = (
    await getPlannerFallbackCandidatesForRoot({
      root: options.root,
      failedModel,
    })
  ).filter((candidate) => !attemptedModels.includes(candidate.model));
  const message = summarizeTuiError(error);

  if (candidates.length > 0) {
    const next = candidates[0]!;

    return {
      actionId: "plan",
      status: "needs-confirmation",
      summary: `Planner fallback ready: ${next.provider}/${next.model}.`,
      canApply: true,
      planContinuation: {
        type: "fallback",
        engine: "llm",
        plannerProvider: next.provider,
        plannerModel: next.model,
        force,
        attemptedModels,
      },
      lines: [
        `primary_error ${message}`,
        `failed_model ${failedModel ?? "unknown"}`,
        `fallback ${next.provider}/${next.model}`,
        `reason ${next.reason}`,
        "press y to try this fallback or n to cancel",
      ],
    };
  }

  return {
    actionId: "plan",
    status: "needs-confirmation",
    summary: `Deterministic fallback ready after planner ${failedModel ?? "LLM"} failed.`,
    canApply: true,
    planContinuation: {
      type: "fallback",
      engine: "deterministic",
      force,
      attemptedModels,
    },
    lines: [
      `primary_error ${message}`,
      `failed_model ${failedModel ?? "unknown"}`,
      "fallback deterministic",
      "press y to preview deterministic handoffs or n to cancel",
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
    `reasoning ${formatReasoningEfforts(options.modelReasoningEfforts)}`,
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
      modelReasoningEfforts: options.modelReasoningEfforts,
      plannerProvider,
      plannerModel: options.plannerModel,
      plannerReasoningEffort: options.plannerReasoningEffort,
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

function makeDefaultSetupDraft(providerChecks: ProviderDoctorResult[] = []): SetupDraft {
  const installedProviders = providerChecks.filter((result) => result.installed).map((result) => result.id).sort(byProviderOrder);
  const providers = installedProviders.length > 0 ? installedProviders : [...SETUP_PROVIDER_OPTIONS];
  const models = defaultSetupModelIds(providers);

  return normalizeSetupDraft({
    providers,
    models,
    reasoningEfforts: {},
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
    reasoningEfforts: current.reasoningEfforts,
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
  const reasoningEfforts = normalizeSetupReasoningEfforts(models, draft.reasoningEfforts);

  return {
    providers,
    models,
    reasoningEfforts,
    plannerModel,
  };
}

function normalizeSetupReasoningEfforts(modelIds: string[], selected: Record<string, string> = {}): Record<string, string> {
  const selectedIds = new Set(modelIds);
  const efforts: Record<string, string> = {};

  for (const model of DEFAULT_MODEL_REGISTRY) {
    if (!selectedIds.has(model.id) || model.reasoning_efforts.length === 0) {
      continue;
    }

    const selectedEffort = selected[model.id];
    efforts[model.id] =
      selectedEffort && model.reasoning_efforts.includes(selectedEffort)
        ? selectedEffort
        : model.default_reasoning_effort ?? model.reasoning_efforts[0]!;
  }

  return efforts;
}

function setupReasoningModels(modelIds: string[]): ModelRegistryEntry[] {
  const selected = new Set(modelIds);

  return DEFAULT_MODEL_REGISTRY.filter(
    (model) => selected.has(model.id) && model.reasoning_efforts.length > 0,
  );
}

function updateSetupReasoningEffort(draft: SetupDraft, modelId: string, effort: string): SetupDraft {
  return normalizeSetupDraft({
    ...draft,
    reasoningEfforts: {
      ...draft.reasoningEfforts,
      [modelId]: effort,
    },
  });
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

function formatContextWindow(tokens: number | undefined): string {
  if (!tokens) {
    return "unknown";
  }

  return formatCompactNumber(tokens);
}

function summarizeStrengths(strengths: string[]): string {
  if (strengths.length === 0) {
    return "No registry strengths listed.";
  }

  return strengths.slice(0, 2).join(" | ");
}

function formatReasoningEfforts(efforts: Record<string, string> | undefined): string {
  const entries = Object.entries(efforts ?? {});

  if (entries.length === 0) {
    return "defaults";
  }

  return entries.map(([model, effort]) => `${model}:${effort}`).join(",");
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
  const [selectedMainMenuIndex, setSelectedMainMenuIndex] = useState(() => mainMenuIndexForView(initialView));
  const [actionResult, setActionResult] = useState<TuiActionResult | undefined>();
  const [runningAction, setRunningAction] = useState<TuiActionId | undefined>();
  const [pendingConfirmation, setPendingConfirmation] = useState<TuiActionId | undefined>();
  const [isEditingRevise, setIsEditingRevise] = useState(false);
  const [reviseInput, setReviseInput] = useState("");
  const [lastReviseChange, setLastReviseChange] = useState<string | undefined>();
  const [chatCommandInput, setChatCommandInput] = useState("");
  const [planChatDraft, setPlanChatDraft] = useState<PlanChatDraft>(() => dashboard.chatDraft || {});
  const [planChatStep, setPlanChatStep] = useState<PlanChatStep>("idle");
  const [planChatInput, setPlanChatInput] = useState("");
  const [hasStartedChatWorkflow, setHasStartedChatWorkflow] = useState(false);
  const [lastPlanAnswers, setLastPlanAnswers] = useState<PlanAnswers | undefined>();
  const [lastPlanForce, setLastPlanForce] = useState(false);
  const [lastPlanEngine, setLastPlanEngine] = useState<PlanEngine>("llm");
  const [lastPlanContinuation, setLastPlanContinuation] = useState<PlanContinuation | undefined>();
  const [lastAgentRequest, setLastAgentRequest] = useState<string | undefined>();
  const [isEditingModelPool, setIsEditingModelPool] = useState(false);
  const [modelPoolInput, setModelPoolInput] = useState("");
  const [isSelectingChatModel, setIsSelectingChatModel] = useState(false);
  const [chatModelCursor, setChatModelCursor] = useState(0);
  const [chatModelScrollOffset, setChatModelScrollOffset] = useState(0);
  const [chatModelEffortCandidate, setChatModelEffortCandidate] = useState<string | undefined>();
  const [chatModelEffortCursor, setChatModelEffortCursor] = useState(0);
  const [slashCommandCursor, setSlashCommandCursor] = useState(0);
  const [slashCommandScrollOffset, setSlashCommandScrollOffset] = useState(0);
  const [isEditingRoot, setIsEditingRoot] = useState(false);
  const [rootInputMode, setRootInputMode] = useState<"choose" | "create">("choose");
  const [rootInput, setRootInput] = useState(dashboard.root);
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupDraft, setSetupDraft] = useState<SetupDraft>(() => makeDefaultSetupDraft(dashboard.setup.providerChecks));
  const [setupProviderCursor, setSetupProviderCursor] = useState(0);
  const [setupModelProviderCursor, setSetupModelProviderCursor] = useState(0);
  const [setupModelCursor, setSetupModelCursor] = useState(0);
  const [setupReasoningModelCursor, setSetupReasoningModelCursor] = useState(0);
  const [setupReasoningEffortCursor, setSetupReasoningEffortCursor] = useState(0);
  const [setupPlannerCursor, setSetupPlannerCursor] = useState(0);

  React.useEffect(() => {
    if (Object.keys(planChatDraft).length > 0 || dashboardState.chatDraft) {
       const draftPath = path.join(dashboardState.root, BLUEPRINT_DIR, "tui_sessions", "DRAFT.json");
       mkdir(path.dirname(draftPath), { recursive: true }).then(() => {
          writeFile(draftPath, JSON.stringify(planChatDraft, null, 2), "utf8").catch(() => {});
       }).catch(() => {});
    }
  }, [planChatDraft, dashboardState.root]);

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
        void mkdir(nextRoot, { recursive: rootInputMode === "create" })
          .then(() => loadTuiDashboard({ root: nextRoot }))
          .then((nextDashboard) => {
            setDashboardState(nextDashboard);
            setRootInput(nextDashboard.root);
            setView("actions");
            setSelectedMainMenuIndex(0);
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

    if (view === "actions" && chatModelEffortCandidate) {
      const model = chatModelsForConnectedProvider(dashboardState).find(
        (candidate) => candidate.id === chatModelEffortCandidate,
      );
      const fullModel = DEFAULT_MODEL_REGISTRY.find((candidate) => candidate.id === chatModelEffortCandidate);
      const efforts = fullModel?.reasoning_efforts ?? [];

      if (key.escape) {
        setChatModelEffortCandidate(undefined);
        setIsSelectingChatModel(false);
        return;
      }

      if (input.toLowerCase() === "b") {
        setChatModelEffortCandidate(undefined);
        setIsSelectingChatModel(true);
        return;
      }

      if (key.upArrow) {
        setChatModelEffortCursor((cursor) => Math.max(cursor - 1, 0));
        return;
      }

      if (key.downArrow) {
        setChatModelEffortCursor((cursor) => Math.min(cursor + 1, Math.max(efforts.length - 1, 0)));
        return;
      }

      if (key.return || input === " ") {
        const effort = efforts[chatModelEffortCursor] ?? fullModel?.default_reasoning_effort;

        if (model) {
          setChatModelEffortCandidate(undefined);
          setIsSelectingChatModel(false);
          void executeAction("planner-model", {
            plannerModel: model.id,
            plannerReasoningEffort: effort,
          });
        }

        return;
      }

      return;
    }

    if (view === "actions" && isSelectingChatModel) {
      const models = chatModelsForConnectedProvider(dashboardState);
      const maxCursor = Math.max(models.length - 1, 0);

      if (key.escape) {
        setIsSelectingChatModel(false);
        return;
      }

      if (key.upArrow) {
        const nextCursor = Math.max(chatModelCursor - 1, 0);
        setChatModelCursor(nextCursor);
        setChatModelScrollOffset(keepIndexVisible(nextCursor, chatModelScrollOffset, TUI_MODEL_SELECTOR_VISIBLE_ROWS));
        return;
      }

      if (key.downArrow) {
        const nextCursor = Math.min(chatModelCursor + 1, maxCursor);
        setChatModelCursor(nextCursor);
        setChatModelScrollOffset(keepIndexVisible(nextCursor, chatModelScrollOffset, TUI_MODEL_SELECTOR_VISIBLE_ROWS));
        return;
      }

      if (key.return || input === " ") {
        const model = models[Math.min(chatModelCursor, maxCursor)];

        if (model) {
          selectChatModelForPlanning(model);
        }

        return;
      }

      return;
    }

    if (view === "actions" && planChatStep !== "idle") {
      if (key.escape) {
        setPlanChatStep("idle");
        setPlanChatInput("");
        return;
      }

      if (key.upArrow) {
        const steps = adaptivePlanChatSteps(planChatDraft);
        const index = steps.indexOf(planChatStep);
        if (index > 0) {
          const prevStep = steps[index - 1]!;
          setPlanChatStep(prevStep);
          const prevVal = planChatDraft[prevStep];
          setPlanChatInput(Array.isArray(prevVal) ? prevVal.join(", ") : (prevVal?.toString() || ""));
        }
        return;
      }

      if (key.downArrow) {
        const steps = adaptivePlanChatSteps(planChatDraft);
        const index = steps.indexOf(planChatStep);
        if (index !== -1 && index < steps.length - 1) {
          const nextStep = steps[index + 1]!;
          setPlanChatStep(nextStep);
          const nextVal = planChatDraft[nextStep];
          setPlanChatInput(Array.isArray(nextVal) ? nextVal.join(", ") : (nextVal?.toString() || ""));
        }
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

    if (pendingConfirmation && view === "actions") {
      if (input.toLowerCase() === "y") {
        void executeAction(pendingConfirmation, {
          apply:
            pendingConfirmation === "revise"
              ? true
              : pendingConfirmation === "plan"
                ? lastPlanContinuation?.type === "apply"
                : false,
          change: pendingConfirmation === "revise" ? lastReviseChange : undefined,
          planAnswers: pendingConfirmation === "plan" ? lastPlanAnswers : undefined,
          planForce: pendingConfirmation === "plan" ? lastPlanForce : undefined,
          planEngine:
            pendingConfirmation === "plan"
              ? lastPlanContinuation?.engine ?? lastPlanEngine
              : undefined,
          planAttemptedModels:
            pendingConfirmation === "plan" || pendingConfirmation === "agent-workflow"
              ? lastPlanContinuation?.attemptedModels
              : undefined,
          plannerProvider:
            pendingConfirmation === "plan" || pendingConfirmation === "agent-workflow"
              ? lastPlanContinuation?.plannerProvider
              : undefined,
          plannerModel:
            pendingConfirmation === "plan" || pendingConfirmation === "agent-workflow"
              ? lastPlanContinuation?.plannerModel
              : undefined,
          agentRequest: pendingConfirmation === "agent-workflow" ? lastAgentRequest : undefined,
        });
      }

      if (input.toLowerCase() === "n" || key.escape) {
        setPendingConfirmation(undefined);
      }

      return;
    }

    if (dashboardState.setup.initialized && view === "actions") {
      const slashSuggestions = getSlashCommandMenuItems(chatCommandInput);
      const slashMenuOpen = chatCommandInput.trimStart().startsWith("/");
      const maxSlashCursor = Math.max(slashSuggestions.length - 1, 0);

      if (key.escape) {
        if (chatCommandInput.length > 0) {
          setChatCommandInput("");
          setSlashCommandCursor(0);
          setSlashCommandScrollOffset(0);
          return;
        }

        if (actionResult) {
          setActionResult(undefined);
          return;
        }

        returnToMainMenu();
        return;
      }

      if ((key.ctrl && input.toLowerCase() === "p") || input === "\u0010") {
        setChatCommandInput("/");
        setSlashCommandCursor(0);
        setSlashCommandScrollOffset(0);
        return;
      }

      if (slashMenuOpen && key.upArrow) {
        const nextCursor = Math.max(slashCommandCursor - 1, 0);
        setSlashCommandCursor(nextCursor);
        setSlashCommandScrollOffset(keepIndexVisible(nextCursor, slashCommandScrollOffset, TUI_SLASH_MENU_VISIBLE_ROWS));
        return;
      }

      if (slashMenuOpen && key.downArrow) {
        const nextCursor = Math.min(slashCommandCursor + 1, maxSlashCursor);
        setSlashCommandCursor(nextCursor);
        setSlashCommandScrollOffset(keepIndexVisible(nextCursor, slashCommandScrollOffset, TUI_SLASH_MENU_VISIBLE_ROWS));
        return;
      }

      if (key.tab || input === "\t") {
        if (!slashMenuOpen) {
          openChatModelSelector();
          return;
        }

        const parts = chatCommandInput.trimStart().split(/\s+/u);
        const typedCommand = parts[0];

        if (parts.length > 1 || chatCommandInput.endsWith(" ")) {
          const typedArg = parts.slice(1).join(" ").trim();

          if (typedCommand === "/model" || typedCommand === "/models") {
            const models = chatModelsForConnectedProvider(dashboardState);
            const matches = models.filter((model) => model.id.startsWith(typedArg));

            if (matches.length > 0) {
              const match = matches.find((model) => model.id !== typedArg) || matches[0];

              if (match) {
                setChatCommandInput(`${typedCommand} ${match.id} `);
                setSlashCommandScrollOffset(0);
              }
            }
          }
          return;
        }

        const suggestion = slashSuggestions[Math.min(slashCommandCursor, maxSlashCursor)];

        if (suggestion) {
          setChatCommandInput(`${suggestion.command} `);
          setSlashCommandCursor(0);
          setSlashCommandScrollOffset(0);
        }

        return;
      }

      if (key.backspace || key.delete) {
        setChatCommandInput((current) => current.slice(0, -1));
        setSlashCommandCursor(0);
        setSlashCommandScrollOffset(0);
        return;
      }

      if (key.return) {
        submitActionChatInput();
        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setChatCommandInput((current) => `${current}${input}`);
        setSlashCommandCursor(0);
        setSlashCommandScrollOffset(0);
      }

      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (key.escape) {
      if (dashboardState.setup.initialized && view !== "main") {
        returnToMainMenu();
        return;
      }

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

    if (dashboardState.setup.initialized && input.toLowerCase() === "m") {
      returnToMainMenu();
      return;
    }

    if (view === "main") {
      if (key.downArrow) {
        setSelectedMainMenuIndex((index) => Math.min(index + 1, TUI_MAIN_MENU_ITEMS.length - 1));
        return;
      }

      if (key.upArrow) {
        setSelectedMainMenuIndex((index) => Math.max(index - 1, 0));
        return;
      }

      if (key.return) {
        openMainMenuIndex(selectedMainMenuIndex);
        return;
      }

      const numeric = Number(input);

      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= TUI_MAIN_MENU_ITEMS.length) {
        openMainMenuIndex(numeric - 1);
      }

      return;
    }

  });

  function openMainMenuIndex(index: number): void {
    const item = TUI_MAIN_MENU_ITEMS[index];

    if (!item) {
      return;
    }

    openSectionView(item.view);
  }

  function openSectionView(nextView: TuiSectionView): void {
    setSelectedMainMenuIndex(mainMenuIndexForView(nextView));
    setView(nextView);
  }

  function returnToMainMenu(): void {
    setSelectedMainMenuIndex(mainMenuIndexForView(view));
    setView("main");
  }

  function openChatModelSelector(): void {
    const models = chatModelsForConnectedProvider(dashboardState);
    const currentModel = dashboardState.profile.profile?.planner_model;
    const currentIndex = models.findIndex((model) => model.id === currentModel);
    const nextCursor = Math.max(currentIndex, 0);

    setChatModelCursor(nextCursor);
    setChatModelScrollOffset(keepIndexVisible(nextCursor, 0, TUI_MODEL_SELECTOR_VISIBLE_ROWS));
    setChatModelEffortCandidate(undefined);
    setChatModelEffortCursor(0);
    setIsSelectingChatModel(true);
    setActionResult(undefined);
  }

  function selectChatModelForPlanning(model: TuiModelSummary): void {
    const registryModel = DEFAULT_MODEL_REGISTRY.find((candidate) => candidate.id === model.id);
    const efforts = registryModel?.reasoning_efforts ?? [];

    if (efforts.length > 1) {
      const currentEffort =
        dashboardState.profile.profile?.model_reasoning_efforts[model.id]
        ?? registryModel?.default_reasoning_effort
        ?? efforts[0];

      setChatModelEffortCandidate(model.id);
      setChatModelEffortCursor(Math.max(efforts.findIndex((effort) => effort === currentEffort), 0));
      return;
    }

    setIsSelectingChatModel(false);
    void executeAction("planner-model", {
      plannerModel: model.id,
      plannerReasoningEffort: registryModel?.default_reasoning_effort ?? efforts[0],
    });
  }

  function submitActionChatInput(): void {
    const value = chatCommandInput.trim();
    setChatCommandInput("");
    setSlashCommandCursor(0);
    setSlashCommandScrollOffset(0);

    if (value.length === 0) {
      return;
    }

    const slash = resolveTuiSlashCommandInput(value, slashCommandCursor);

    if (!slash) {
      submitFreeformPlanRequest(value);
      return;
    }

    handleSlashCommand(slash);
  }

  function handleSlashCommand(command: ParsedTuiSlashCommand): void {
    if (command.command === "/plan") {
      if (command.argument.length > 0) {
        submitFreeformPlanRequest(command.argument);
        return;
      }

      const planAnswers = dashboardState.agentState ? parseWorkflowPlanAnswers(dashboardState.agentState) : undefined;

      if (planAnswers) {
        setLastPlanAnswers(planAnswers);
        setLastPlanForce(dashboardState.tasks.length > 0);
        setLastPlanEngine("llm");
        setLastPlanContinuation({
          type: "preview",
          engine: "llm",
          plannerProvider: dashboardState.agentState?.planner.provider,
          plannerModel: dashboardState.agentState?.planner.model,
          force: dashboardState.tasks.length > 0,
        });
        setPendingConfirmation("plan");
        return;
      }

      setActionResult({
        actionId: "plan",
        status: "failed",
        summary: "Missing planning request.",
        lines: ["Type the request directly in the chat, use /plan <brief>, or continue until the planner is ready to preview."],
      });
      return;
    }

    if (command.command === "/providers") {
      setActionResult(buildProvidersSlashResult(dashboardState));
      return;
    }

    if (command.command === "/models") {
      if (command.argument.length > 0) {
        void executeAction("model-pool", { modelPool: command.argument });
        return;
      }

      setModelPoolInput(dashboardState.profile.profile?.available_models.join(",") || "all");
      setIsEditingModelPool(true);
      return;
    }

    if (command.command === "/model") {
      if (command.argument.length > 0) {
        const model = chatModelsForConnectedProvider(dashboardState).find((candidate) => candidate.id === command.argument);

        if (model) {
          selectChatModelForPlanning(model);
          return;
        }

        void executeAction("planner-model", { plannerModel: command.argument });
        return;
      }

      openChatModelSelector();
      return;
    }

    if (command.command === "/registry") {
      setPendingConfirmation("registry-refresh");
      return;
    }

    if (command.command === "/lint") {
      void executeAction("lint", {});
      return;
    }

    if (command.command === "/export") {
      void executeAction("export", {});
      return;
    }

    if (command.command === "/revise") {
      if (command.argument.length > 0) {
        void executeAction("revise", { change: command.argument, apply: false });
        return;
      }

      setReviseInput(lastReviseChange ?? "");
      setIsEditingRevise(true);
      return;
    }

    if (command.command === "/auth") {
      void executeAction("auth-doctor", {});
      return;
    }

    if (command.command === "/auth-live") {
      setPendingConfirmation("auth-doctor-live");
      return;
    }

    if (command.command === "/menu") {
      returnToMainMenu();
      return;
    }

    if (command.command === "/sessions") {
      setActionResult(buildSessionsSlashResult(dashboardState));
      return;
    }

    if (command.command === "/clear") {
      void clearSavedAgentSession();
      return;
    }

    if (command.command === "/resume") {
      if (dashboardState.agentSession?.agent_state || dashboardState.agentState) {
        const state = dashboardState.agentSession?.agent_state ?? dashboardState.agentState;
        setHasStartedChatWorkflow(true);
        setPlanChatDraft(state?.user_request ? { brief: state.user_request } : {});
        setActionResult({
          actionId: "help",
          status: "ok",
          summary: "Resumed the saved planning session.",
          lines: [
            `session ${dashboardState.agentSession?.session_id ?? "legacy"}`,
            `phase ${state?.project_state.current_phase ?? "unknown"}`,
            `next ${state?.next_action.label ?? "continue planning"}`,
          ],
        });
        return;
      }

      if (dashboardState.chatDraft && dashboardState.chatDraft.brief) {
        setHasStartedChatWorkflow(true);
        setPlanChatDraft(dashboardState.chatDraft);
        setActionResult(undefined);
      } else {
        setActionResult({
          actionId: "help",
          status: "failed",
          summary: "No active planning session draft found to resume.",
          lines: [],
        });
      }
      return;
    }

    setActionResult(buildHelpSlashResult());
  }

  async function clearSavedAgentSession(): Promise<void> {
    try {
      await clearPlannerAgentSession(dashboardState.root);
      const nextDashboard = await loadTuiDashboard({ root: dashboardState.root });
      setDashboardState(nextDashboard);
      setHasStartedChatWorkflow(false);
      setLastAgentRequest(undefined);
      setPlanChatDraft({});
      setActionResult({
        actionId: "sessions",
        status: "ok",
        summary: "Cleared the saved planning session.",
        lines: ["landing restored", "artifacts and action history were not removed"],
      });
    } catch (error) {
      setActionResult({
        actionId: "sessions",
        status: "failed",
        summary: "Failed to clear the saved planning session.",
        lines: [summarizeTuiError(error)],
      });
    }
  }

  function submitFreeformPlanRequest(brief: string): void {
    setHasStartedChatWorkflow(true);
    setLastAgentRequest(brief);
    setPlanChatInput("");
    setPlanChatStep("idle");
    setPlanChatDraft({ brief });
    setLastPlanAnswers(undefined);
    setLastPlanForce(false);
    setLastPlanEngine("llm");
    setLastPlanContinuation(undefined);
    setPendingConfirmation(undefined);
    setActionResult(undefined);
    void executeAction("agent-workflow", { agentRequest: brief });
  }

  function beginPlanChat(initialBrief?: string): void {
    const draft = initialBrief ? { brief: initialBrief } : {};
    setPlanChatInput("");
    setLastPlanAnswers(undefined);
    setLastPlanForce(false);
    setLastPlanEngine("llm");
    setLastPlanContinuation(undefined);
    setPendingConfirmation(undefined);
    setActionResult(undefined);
    setPlanChatDraft(draft);
    setPlanChatStep(firstPlanChatStep(draft));
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

    const nextStep = nextPlanChatStep(planChatStep, nextDraft);
    setPlanChatDraft(nextDraft);
    setPlanChatInput("");
    setActionResult(undefined);

    if (nextStep) {
      setPlanChatStep(nextStep);
      return;
    }

    const answers = buildPlanAnswersFromDraft(nextDraft);
    const force = dashboardState.tasks.length > 0;
    const engine: PlanEngine = "llm";
    setPlanChatStep("idle");
    setLastPlanAnswers(answers);
    setLastPlanForce(force);
    setLastPlanEngine(engine);
    void executeAction("plan", {
      planAnswers: answers,
      planForce: force,
      planEngine: engine,
      apply: false,
    });
  }

  function beginSetupFlow(): void {
    const draft = makeDefaultSetupDraft(dashboardState.setup.providerChecks);
    setSetupDraft(draft);
    setSetupProviderCursor(0);
    setSetupModelProviderCursor(0);
    setSetupModelCursor(0);
    setSetupReasoningModelCursor(0);
    setSetupReasoningEffortCursor(0);
    setSetupPlannerCursor(0);
    setSetupStep("providers");
    setPendingConfirmation(undefined);
    setActionResult(undefined);
  }

  function openSetupPlannerStep(draft: SetupDraft): void {
    const plannerModels = setupPlannerModels(draft.models);
    const plannerIndex = Math.max(
      plannerModels.findIndex((model) => model.id === draft.plannerModel),
      0,
    );

    setSetupPlannerCursor(plannerIndex);
    setSetupStep("planner");
  }

  function setupReasoningEffortIndex(draft: SetupDraft, model: ModelRegistryEntry): number {
    return Math.max(
      model.reasoning_efforts.findIndex((effort) => effort === draft.reasoningEfforts[model.id]),
      0,
    );
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
      const maxCursor = Math.max(models.length - 1, 0);

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

        if (input.toLowerCase() === "a") {
          const allSelected = selectedForProvider.length === providerModelIds.length;
          setSetupDraft(updateSetupModelsForProvider(setupDraft, provider, allSelected ? [] : providerModelIds));
          return;
        }

        const model = models[Math.min(setupModelCursor, maxCursor)];

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

        const reasoningModels = setupReasoningModels(setupDraft.models);

        if (reasoningModels.length > 0) {
          setSetupReasoningModelCursor(0);
          setSetupReasoningEffortCursor(setupReasoningEffortIndex(setupDraft, reasoningModels[0]!));
          setSetupStep("reasoning");
          setActionResult(undefined);
          return;
        }

        openSetupPlannerStep(setupDraft);
        setActionResult(undefined);
        return;
      }
    }

    if (setupStep === "reasoning") {
      const models = setupReasoningModels(setupDraft.models);
      const model = models[setupReasoningModelCursor];
      const efforts = model?.reasoning_efforts ?? [];

      if (input.toLowerCase() === "b") {
        if (setupReasoningModelCursor > 0) {
          const previousCursor = setupReasoningModelCursor - 1;
          setSetupReasoningModelCursor(previousCursor);
          setSetupReasoningEffortCursor(setupReasoningEffortIndex(setupDraft, models[previousCursor]!));
        } else {
          setSetupStep("models");
        }
        return;
      }

      if (!model || efforts.length === 0) {
        openSetupPlannerStep(setupDraft);
        return;
      }

      if (key.upArrow) {
        setSetupReasoningEffortCursor((cursor) => Math.max(cursor - 1, 0));
        return;
      }

      if (key.downArrow) {
        setSetupReasoningEffortCursor((cursor) => Math.min(cursor + 1, efforts.length - 1));
        return;
      }

      if (key.return || input === " ") {
        const nextDraft = updateSetupReasoningEffort(setupDraft, model.id, efforts[setupReasoningEffortCursor] ?? efforts[0]!);
        setSetupDraft(nextDraft);

        if (setupReasoningModelCursor < models.length - 1) {
          const nextCursor = setupReasoningModelCursor + 1;
          setSetupReasoningModelCursor(nextCursor);
          setSetupReasoningEffortCursor(setupReasoningEffortIndex(nextDraft, models[nextCursor]!));
          setActionResult(undefined);
          return;
        }

        openSetupPlannerStep(nextDraft);
        setActionResult(undefined);
        return;
      }
    }

    if (setupStep === "planner") {
      const models = setupPlannerModels(setupDraft.models);

      if (input.toLowerCase() === "b") {
        const reasoningModels = setupReasoningModels(setupDraft.models);

        if (reasoningModels.length > 0) {
          const lastReasoningCursor = Math.max(reasoningModels.length - 1, 0);
          setSetupReasoningModelCursor(lastReasoningCursor);
          setSetupReasoningEffortCursor(setupReasoningEffortIndex(setupDraft, reasoningModels[lastReasoningCursor]!));
          setSetupStep("reasoning");
        } else {
          setSetupStep("models");
        }
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
          modelReasoningEfforts: setupDraft.reasoningEfforts,
          plannerProvider,
          plannerModel,
          plannerReasoningEffort: setupDraft.reasoningEfforts[plannerModel],
        });
      }
    }
  }

  async function executeAction(
    actionId: TuiActionId,
    options: {
      change?: string;
      modelPool?: string;
      agentRequest?: string;
      planAnswers?: PlanAnswers;
      planEngine?: PlanEngine;
      planForce?: boolean;
      planAttemptedModels?: string[];
      providers?: ProviderId[];
      models?: string[];
      modelReasoningEfforts?: Record<string, string>;
      plannerProvider?: ProviderId;
      plannerModel?: string;
      plannerReasoningEffort?: string;
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
        agentRequest: options.agentRequest,
        planAnswers: options.planAnswers,
        planEngine: options.planEngine,
        planForce: options.planForce,
        planAttemptedModels: options.planAttemptedModels,
        providers: options.providers,
        models: options.models,
        modelReasoningEfforts: options.modelReasoningEfforts,
        plannerProvider: options.plannerProvider,
        plannerModel: options.plannerModel,
        plannerReasoningEffort: options.plannerReasoningEffort,
        apply: options.apply,
      });
      setActionResult(shouldDisplayTuiActionResult(result) ? result : undefined);

      if (result.actionId === "revise" && result.change) {
        setLastReviseChange(result.change);

        if (result.canApply && !options.apply) {
          setPendingConfirmation("revise");
        }
      }

      if (result.actionId === "plan" && result.canApply && !options.apply) {
        setLastPlanContinuation(result.planContinuation);
        setLastPlanEngine(result.planContinuation?.engine ?? options.planEngine ?? lastPlanEngine);
        setPendingConfirmation("plan");
      }

      if (result.actionId === "agent-workflow" && result.canApply) {
        setLastPlanContinuation(result.planContinuation);

        if (result.planContinuation?.type === "fallback") {
          setLastAgentRequest(options.agentRequest);
          setPendingConfirmation("agent-workflow");
        } else if (result.planAnswers) {
          setLastPlanAnswers(result.planAnswers);
          setLastPlanForce(Boolean(result.planContinuation?.force));
          setLastPlanEngine(result.planContinuation?.engine ?? "llm");
          setPendingConfirmation("plan");
        }
      }

      const nextDashboard = await loadTuiDashboard({ root: dashboardState.root });
      setDashboardState(nextDashboard);

      if (actionId === "setup" && result.status === "ok" && nextDashboard.setup.initialized) {
        setView("actions");
        setSelectedMainMenuIndex(mainMenuIndexForView("actions"));
      }
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
    selectedMainMenuIndex,
    actionResult,
    runningAction,
    pendingConfirmation,
    isEditingRevise,
    reviseInput,
    chatCommandInput,
    hasStartedChatWorkflow,
    planChatStep,
    planChatDraft,
    planChatInput,
    isEditingModelPool,
    modelPoolInput,
    isSelectingChatModel,
    chatModelCursor,
    chatModelScrollOffset,
    chatModelEffortCandidate,
    chatModelEffortCursor,
    slashCommandCursor,
    slashCommandScrollOffset,
    isEditingRoot,
    rootInputMode,
    rootInput,
    setupStep,
    setupDraft,
    setupProviderCursor,
    setupModelProviderCursor,
    setupModelCursor,
    setupReasoningModelCursor,
    setupReasoningEffortCursor,
    setupPlannerCursor,
  });
}

export function BlueprintDashboard({
  dashboard,
  view = "actions",
  selectedMainMenuIndex = 0,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  chatCommandInput = "",
  hasStartedChatWorkflow = false,
  planChatStep = "idle",
  planChatDraft = {},
  planChatInput = "",
  isEditingModelPool,
  modelPoolInput,
  isSelectingChatModel,
  chatModelCursor = 0,
  chatModelScrollOffset = 0,
  chatModelEffortCandidate,
  chatModelEffortCursor = 0,
  slashCommandCursor = 0,
  slashCommandScrollOffset = 0,
  isEditingRoot,
  rootInputMode,
  rootInput,
  setupStep = "idle",
  setupDraft = makeDefaultSetupDraft(),
  setupProviderCursor = 0,
  setupModelProviderCursor = 0,
  setupModelCursor = 0,
  setupReasoningModelCursor = 0,
  setupReasoningEffortCursor = 0,
  setupPlannerCursor = 0,
}: {
  dashboard: TuiDashboard;
  view?: TuiView;
  selectedMainMenuIndex?: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  chatCommandInput?: string;
  hasStartedChatWorkflow?: boolean;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  chatModelScrollOffset?: number;
  chatModelEffortCandidate?: string;
  chatModelEffortCursor?: number;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
  isEditingRoot?: boolean;
  rootInputMode?: "choose" | "create";
  rootInput?: string;
  setupStep?: SetupStep;
  setupDraft?: SetupDraft;
  setupProviderCursor?: number;
  setupModelProviderCursor?: number;
  setupModelCursor?: number;
  setupReasoningModelCursor?: number;
  setupReasoningEffortCursor?: number;
  setupPlannerCursor?: number;
}): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const lintStatus = dashboard.lint.errors.length === 0 ? "ok" : "error";
  const appStatus = dashboard.setup.initialized ? lintStatus : "warn";
  const chatSurface = dashboard.setup.initialized && view === "actions";
  const isInteractiveTty = Boolean(process.stdout.isTTY);
  const terminalRows = rows > 0 ? rows : process.stdout.rows || 24;
  const terminalColumns = columns > 0 ? columns : process.stdout.columns || 100;

  return h(
    Box,
    isInteractiveTty
      ? { flexDirection: "column", height: terminalRows, width: terminalColumns, overflow: "hidden" as any }
      : { flexDirection: "column", minHeight: terminalRows },
    ...(!chatSurface
      ? [
          h(
            Box,
            {
              key: "header",
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
        ]
      : []),
    ...(dashboard.setup.initialized && view !== "main" && view !== "actions" ? [h(SectionHeader, { key: "section", view })] : []),
    h(
      Box,
      isInteractiveTty
        ? { key: "viewport", flexDirection: "column", flexGrow: 1, overflow: "hidden" as any }
        : { key: "viewport", flexDirection: "column", flexGrow: 1 },
      h(ActiveView, {
        dashboard,
        view,
        lintStatus,
        selectedMainMenuIndex,
        actionResult,
        runningAction,
        pendingConfirmation,
        isEditingRevise,
        reviseInput,
        chatCommandInput,
        hasStartedChatWorkflow,
        planChatStep,
        planChatDraft,
        planChatInput,
        isEditingModelPool,
        modelPoolInput,
        isSelectingChatModel,
        chatModelCursor,
        chatModelScrollOffset,
        chatModelEffortCandidate,
        chatModelEffortCursor,
        slashCommandCursor,
        slashCommandScrollOffset,
        isEditingRoot,
        rootInputMode,
        rootInput,
        setupStep,
        setupDraft,
        setupProviderCursor,
        setupModelProviderCursor,
        setupModelCursor,
        setupReasoningModelCursor,
        setupReasoningEffortCursor,
        setupPlannerCursor,
      }),
    ),
    ...(!chatSurface
      ? [
          h(KeyHints, {
            key: "key-hints",
            view,
            setupInitialized: dashboard.setup.initialized,
            pendingConfirmation,
            isEditingRevise,
            planChatStep,
            isEditingModelPool,
            isSelectingChatModel,
            chatModelEffortCandidate,
            isEditingRoot,
            runningAction,
            setupStep,
          }),
        ]
      : []),
  );
}

function ActiveView({
  dashboard,
  view,
  lintStatus,
  selectedMainMenuIndex,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  chatCommandInput,
  hasStartedChatWorkflow,
  planChatStep,
  planChatDraft,
  planChatInput,
  isEditingModelPool,
  modelPoolInput,
  isSelectingChatModel,
  chatModelCursor,
  chatModelScrollOffset,
  chatModelEffortCandidate,
  chatModelEffortCursor,
  slashCommandCursor,
  slashCommandScrollOffset,
  isEditingRoot,
  rootInputMode,
  rootInput,
  setupStep,
  setupDraft,
  setupProviderCursor,
  setupModelProviderCursor,
  setupModelCursor,
  setupReasoningModelCursor,
  setupReasoningEffortCursor,
  setupPlannerCursor,
}: {
  dashboard: TuiDashboard;
  view: TuiView;
  lintStatus: "ok" | "error";
  selectedMainMenuIndex: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  chatCommandInput?: string;
  hasStartedChatWorkflow?: boolean;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  chatModelScrollOffset?: number;
  chatModelEffortCandidate?: string;
  chatModelEffortCursor?: number;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
  isEditingRoot?: boolean;
  rootInputMode?: "choose" | "create";
  rootInput?: string;
  setupStep?: SetupStep;
  setupDraft?: SetupDraft;
  setupProviderCursor?: number;
  setupModelProviderCursor?: number;
  setupModelCursor?: number;
  setupReasoningModelCursor?: number;
  setupReasoningEffortCursor?: number;
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
      setupReasoningModelCursor,
      setupReasoningEffortCursor,
      setupPlannerCursor,
    });
  }

  if (view === "main") {
    return h(MainMenuView, { dashboard, lintStatus, selectedMainMenuIndex });
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
      actionResult,
      runningAction,
      pendingConfirmation,
      isEditingRevise,
      reviseInput,
      chatCommandInput,
      hasStartedChatWorkflow,
      planChatStep,
      planChatDraft,
      planChatInput,
      isEditingModelPool,
      modelPoolInput,
      isSelectingChatModel,
      chatModelCursor,
      chatModelScrollOffset,
      chatModelEffortCandidate,
      chatModelEffortCursor,
      slashCommandCursor,
      slashCommandScrollOffset,
    });
  }

  return h(OverviewView, { dashboard, lintStatus });
}

function MainMenuView({
  dashboard,
  lintStatus,
  selectedMainMenuIndex,
}: {
  dashboard: TuiDashboard;
  lintStatus: "ok" | "error";
  selectedMainMenuIndex: number;
}): React.ReactElement {
  const rows = buildMainMenuRows(dashboard, lintStatus);
  const selectedRow = rows[Math.min(selectedMainMenuIndex, rows.length - 1)] ?? rows[0]!;

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(OperationalSummary, { dashboard, lintStatus }),
    h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Main Menu"),
      ...rows.map((row, index) =>
        h(
          Text,
          {
            key: row.item.view,
            color: index === selectedMainMenuIndex ? "cyan" : undefined,
            bold: index === selectedMainMenuIndex,
          },
          `${index === selectedMainMenuIndex ? ">" : " "} ${index + 1}. ${row.item.label} | ${row.status}`,
        ),
      ),
    ),
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, selectedRow.item.label),
      h(Text, null, selectedRow.item.description),
      h(Text, { color: "gray" }, selectedRow.detail),
    ),
  );
}

function SectionHeader({ view }: { view: TuiView }): React.ReactElement {
  const item = TUI_MAIN_MENU_ITEMS.find((menuItem) => menuItem.view === view);
  const shortcut = view === "actions" ? "  |  Esc main menu" : "  |  m main menu";

  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1 },
    h(Text, { bold: true }, item?.label ?? view),
    h(Text, { color: "gray" }, shortcut),
  );
}

function buildMainMenuRows(
  dashboard: TuiDashboard,
  lintStatus: "ok" | "error",
): { item: TuiMainMenuItem; status: string; detail: string }[] {
  return TUI_MAIN_MENU_ITEMS.map((item) => ({
    item,
    status: mainMenuStatus(item.view, dashboard, lintStatus),
    detail: mainMenuDetail(item.view, dashboard),
  }));
}

function mainMenuStatus(view: TuiSectionView, dashboard: TuiDashboard, lintStatus: "ok" | "error"): string {
  const profile = dashboard.profile.profile;

  if (view === "actions") {
    return dashboard.tasks.length > 0 ? "handoffs ready" : "start here";
  }

  if (view === "overview") {
    return lintStatus === "ok" ? "healthy" : "needs attention";
  }

  if (view === "tasks") {
    return `${dashboard.tasks.length} task(s)`;
  }

  if (view === "graph") {
    return dashboard.graph ? `${dashboard.graph.nodes.length} nodes / ${dashboard.graph.edges.length} edges` : "missing";
  }

  return profile
    ? `${profile.available_providers.length} provider(s) / ${profile.available_models.length || "default"} model(s)`
    : "profile missing";
}

function mainMenuDetail(view: TuiSectionView, dashboard: TuiDashboard): string {
  const profile = dashboard.profile.profile;

  if (view === "actions") {
    return dashboard.nextAction;
  }

  if (view === "overview") {
    return `root ${dashboard.root}`;
  }

  if (view === "tasks") {
    return dashboard.tasks.length > 0
      ? `latest ${dashboard.tasks.at(-1)?.id ?? "none"}`
      : "no generated task handoffs";
  }

  if (view === "graph") {
    return dashboard.graph ? `${BLUEPRINT_DIR}/dependencies_graph.json` : "dependencies_graph.json is missing";
  }

  return profile ? `planner ${profile.planner_provider}/${profile.planner_model}` : "run setup to create profile.yaml";
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
  setupReasoningModelCursor = 0,
  setupReasoningEffortCursor = 0,
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
  setupReasoningModelCursor?: number;
  setupReasoningEffortCursor?: number;
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
        h(Text, null, "Configure providers, model pool, reasoning effort, and planner before the harness writes files."),
      ),
      h(SetupStepPanel, {
        setupStep,
        setupDraft,
        providerChecks: dashboard.setup.providerChecks,
        setupProviderCursor,
        setupModelProviderCursor,
        setupModelCursor,
        setupReasoningModelCursor,
        setupReasoningEffortCursor,
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
    h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Provider CLIs"),
      ...formatProviderCheckLines(dashboard.setup.providerChecks).map((line) => h(Text, { key: line }, line)),
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
              borderColor: actionResult.status === "ok" ? "green" : actionResult.status === "needs-confirmation" ? "yellow" : "red",
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
  providerChecks,
  setupProviderCursor,
  setupModelProviderCursor,
  setupModelCursor,
  setupReasoningModelCursor,
  setupReasoningEffortCursor,
  setupPlannerCursor,
}: {
  setupStep: SetupStep;
  setupDraft: SetupDraft;
  providerChecks: ProviderDoctorResult[];
  setupProviderCursor: number;
  setupModelProviderCursor: number;
  setupModelCursor: number;
  setupReasoningModelCursor: number;
  setupReasoningEffortCursor: number;
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
        `${setupProviderCursor === 0 ? ">" : " "} [${allSelected ? "x" : " "}] ALL PROVIDERS`,
      ),
      ...SETUP_PROVIDER_OPTIONS.map((provider, index) => {
        const cursor = index + 1;
        const selected = setupDraft.providers.includes(provider);
        const check = providerChecks.find((result) => result.id === provider);
        const status = check
          ? `${check.cli} ${check.installed ? "installed" : "missing"}`
          : `${PROVIDER_LABELS[provider].split(" / ")[1] ?? provider} unknown`;

        return h(
          Text,
          {
            key: provider,
            color: setupProviderCursor === cursor ? "cyan" : undefined,
            bold: setupProviderCursor === cursor,
          },
          `${setupProviderCursor === cursor ? ">" : " "} [${selected ? "x" : " "}] ${PROVIDER_DISPLAY_NAMES[provider]} | ${status}`,
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
    const selectedIndex = Math.min(setupModelCursor, Math.max(models.length - 1, 0));
    const model = models[selectedIndex];

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(
        Text,
        { bold: true },
        `2. Model Pool ${provider ? `(${setupModelProviderCursor + 1}/${setupDraft.providers.length} ${PROVIDER_DISPLAY_NAMES[provider]})` : ""}`,
      ),
      h(Text, null, "Choose exact models available for routing, one card at a time."),
      h(Text, { color: "gray" }, `Selected ${selectedCount}/${models.length}${allSelected ? " (all)" : ""}`),
      ...(model
        ? [
            h(Text, { key: "position", color: "gray" }, `Model ${selectedIndex + 1}/${models.length}`),
            h(
              Text,
              {
                key: model.id,
                color: "cyan",
                bold: true,
              },
              `> [${setupDraft.models.includes(model.id) ? "x" : " "}] ${model.id}`,
            ),
            h(Text, { key: "meta" }, `${model.tier}/${model.status} | context ${formatContextWindow(model.context_window)}`),
            h(Text, { key: "fit" }, `planning ${formatScore(model.task_fit.planning)} | coding ${formatScore(model.task_fit.coding)}`),
            h(Text, { key: "strength", color: "gray" }, summarizeStrengths(model.strengths)),
          ]
        : [h(Text, { key: "empty", color: "yellow" }, "No models available for this provider.")]),
      h(Text, { color: "gray" }, "Up/down changes model, Space toggles, a selects all for provider, Enter continues, b goes back."),
    );
  }

  if (setupStep === "reasoning") {
    const models = setupReasoningModels(setupDraft.models);
    const model = models[setupReasoningModelCursor];
    const efforts = model?.reasoning_efforts ?? [];
    const selectedIndex = Math.min(setupReasoningEffortCursor, Math.max(efforts.length - 1, 0));
    const effort = efforts[selectedIndex];

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(
        Text,
        { bold: true },
        `3. Reasoning Effort ${model ? `(${setupReasoningModelCursor + 1}/${models.length})` : ""}`,
      ),
      h(Text, null, model ? `${model.id} | ${PROVIDER_DISPLAY_NAMES[model.provider]}` : "No selected model exposes effort options."),
      ...(effort && model
        ? [
            h(Text, { key: "position", color: "gray" }, `Effort ${selectedIndex + 1}/${efforts.length}`),
            h(
              Text,
              {
                key: effort,
                color: "cyan",
                bold: true,
              },
              `> [${setupDraft.reasoningEfforts[model.id] === effort ? "x" : " "}] ${effort}${model.default_reasoning_effort === effort ? " default" : ""}`,
            ),
          ]
        : [h(Text, { key: "empty", color: "yellow" }, "No effort options for this model.")]),
      h(Text, { color: "gray" }, "Up/down changes effort, Enter confirms this model, b goes back."),
    );
  }

  if (setupStep === "planner") {
    const models = setupPlannerModels(setupDraft.models);
    const selectedIndex = Math.min(setupPlannerCursor, Math.max(models.length - 1, 0));
    const model = models[selectedIndex];

    return h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "4. Planner Model"),
      h(Text, null, "Choose the model that will run the planning conversation."),
      ...(model
        ? [
            h(Text, { key: "position", color: "gray" }, `Candidate ${selectedIndex + 1}/${models.length}`),
            h(
              Text,
              {
                key: model.id,
                color: "cyan",
                bold: true,
              },
              `> ${model.id}`,
            ),
            h(Text, { key: "provider" }, `${PROVIDER_DISPLAY_NAMES[model.provider]} | effort ${setupDraft.reasoningEfforts[model.id] ?? "default"}`),
            h(Text, { key: "planning" }, `planning ${formatScore(model.task_fit.planning)} | ${model.tier}/${model.status}`),
          ]
        : [h(Text, { key: "empty", color: "yellow" }, "No selected models can be used as planner.")]),
      h(Text, { color: "gray" }, "Up/down changes planner, b goes back, Enter confirms."),
    );
  }

  const plannerModel = setupDraft.plannerModel ?? chooseDefaultPlannerModel(setupDraft.models) ?? "missing";
  const plannerProvider = providerForModelId(plannerModel);

  return h(
    Box,
    { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "5. Confirm Setup"),
    h(Text, null, `Status: ${plannerProvider ? "ready to write" : "needs planner model"}`),
    h(Text, null, `Providers: ${setupDraft.providers.join(",")}`),
    h(Text, null, `Models: ${setupDraft.models.length} selected`),
    h(Text, null, `Reasoning: ${Object.keys(setupDraft.reasoningEfforts).length} configured`),
    h(Text, null, `Planner: ${plannerProvider ?? "unknown"}/${plannerModel} effort ${setupDraft.reasoningEfforts[plannerModel] ?? "default"}`),
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
    h(OperationalSummary, { dashboard, lintStatus }),
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
          `stack ${dashboard.doctor.stack.join(",") || "unknown"}`,
          `canonical ${dashboard.doctor.canonicalFiles.length}`,
          `manifests ${summarizeManifests(dashboard.doctor.manifests)}`,
          `top_dirs ${summarizeList(dashboard.doctor.topLevelDirs, 4)}`,
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

function OperationalSummary({
  dashboard,
  lintStatus,
}: {
  dashboard: TuiDashboard;
  lintStatus: "ok" | "error";
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const status =
    !dashboard.setup.initialized
      ? "setup required"
      : dashboard.profile.errors.length > 0 || !profile
        ? "profile blocked"
        : dashboard.tasks.length === 0
          ? "ready to plan"
          : lintStatus === "error"
            ? "lint blocked"
            : "handoffs ready";
  const activeModelCount = profile?.available_models.length ?? 0;
  const taskModels = unique(dashboard.tasks.map((task) => task.suggestedModel));

  return h(
    Box,
    { borderStyle: "round", borderColor: lintStatus === "ok" ? "cyan" : "yellow", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Operations"),
    h(Text, null, `root ${dashboard.root}`),
    h(Text, null, `status ${status}`),
    h(
      Text,
      null,
      `planner ${profile ? `${profile.planner_provider}/${profile.planner_model}` : "missing"} | provider_pool ${
        profile?.available_providers.join(",") ?? "missing"
      } | model_pool ${activeModelCount > 0 ? activeModelCount : "default"}`,
    ),
    h(
      Text,
      null,
      `tasks ${dashboard.tasks.length} | task_models ${taskModels.length > 0 ? summarizeList(taskModels, 3) : "none"} | sessions ${
        dashboard.tuiSessions.length
      }`,
    ),
    h(Text, { color: "gray" }, dashboard.nextAction),
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
          ? summarizeModelLines(
              dashboard.registryModels.map(
                (model) =>
                  `${model.id} ${model.tier}/${model.status} effort ${model.defaultReasoningEffort ?? "auto"}`,
              ),
            )
          : ["registry unavailable"],
    }),
    h(MessageList, { title: "Profile Messages", messages: [...dashboard.profile.errors, ...dashboard.profile.warnings] }),
  );
}

function ActionsView({
  dashboard,
  actionResult,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  chatCommandInput = "",
  hasStartedChatWorkflow = false,
  planChatStep = "idle",
  planChatDraft = {},
  planChatInput = "",
  isEditingModelPool,
  modelPoolInput,
  isSelectingChatModel,
  chatModelCursor = 0,
  chatModelScrollOffset = 0,
  chatModelEffortCandidate,
  chatModelEffortCursor = 0,
  slashCommandCursor = 0,
  slashCommandScrollOffset = 0,
}: {
  dashboard: TuiDashboard;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  chatCommandInput?: string;
  hasStartedChatWorkflow?: boolean;
  planChatStep?: PlanChatStep;
  planChatDraft?: PlanChatDraft;
  planChatInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  chatModelScrollOffset?: number;
  chatModelEffortCandidate?: string;
  chatModelEffortCursor?: number;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
}): React.ReactElement {
  const landing = isLandingChatSurface({
    actionResult,
    runningAction,
    hasStartedChatWorkflow,
    planChatStep,
  });

  if (landing) {
    return h(LandingSurface, {
      dashboard,
      chatCommandInput,
      actionResult,
      pendingConfirmation,
      isEditingRevise,
      reviseInput,
      isEditingModelPool,
      modelPoolInput,
      isSelectingChatModel,
      chatModelCursor,
      chatModelScrollOffset,
      chatModelEffortCandidate,
      chatModelEffortCursor,
      slashCommandCursor,
      slashCommandScrollOffset,
      planChatStep,
      planChatInput,
    });
  }

  return h(WorkbenchSurface, {
    dashboard,
    runningAction,
    pendingConfirmation,
    isEditingRevise,
    reviseInput,
    chatCommandInput,
    planChatStep,
    planChatDraft,
    planChatInput,
    isEditingModelPool,
    modelPoolInput,
    isSelectingChatModel,
    chatModelCursor,
    chatModelScrollOffset,
    chatModelEffortCandidate,
    chatModelEffortCursor,
    slashCommandCursor,
    slashCommandScrollOffset,
    actionResult,
    isolateCurrentRun: hasStartedChatWorkflow && runningAction === "agent-workflow",
  });
}













export function estimateContextTokens(dashboard: TuiDashboard): number {
  const inventoryBytes = dashboard.doctor.inventoryFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const structuralTokens = dashboard.doctor.fileCount * 8 + dashboard.doctor.canonicalFiles.length * 120;

  return Math.max(0, Math.round(inventoryBytes / 4) + structuralTokens);
}

export function contextUsePercent(dashboard: TuiDashboard): number {
  if (dashboard.doctor.warnings.length === 0 && dashboard.lint.errors.length === 0) {
    return dashboard.tasks.length > 0 ? 33 : 18;
  }

  return dashboard.setup.initialized ? 12 : 4;
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return String(value);
}

export function providerStatusLabel(provider: ProviderDoctorResult): string {
  if (!provider.installed) {
    return "missing";
  }

  if (provider.authCheck === "ok") {
    return "Connected";
  }

  if (provider.authCheck === "failed") {
    return "auth failed";
  }

  return "available";
}

export function chatModelsForConnectedProvider(dashboard: TuiDashboard): TuiModelSummary[] {
  const provider = dashboard.profile.profile?.planner_provider;

  if (!provider) {
    return [];
  }

  return dashboard.registryModels
    .filter((model) => model.provider === provider)
    .sort((left, right) => {
      const currentModel = dashboard.profile.profile?.planner_model;

      if (left.id === currentModel) {
        return -1;
      }

      if (right.id === currentModel) {
        return 1;
      }

      return left.id.localeCompare(right.id);
    });
}

export function runtimeStatusColor(status: string): "green" | "yellow" | "red" | "gray" {
  if (status === "ready") {
    return "green";
  }

  if (status === "blocked") {
    return "red";
  }

  if (status === "running" || status === "planning" || status === "needs-confirmation") {
    return "yellow";
  }

  return "gray";
}




function buildHelpSlashResult(): TuiActionResult {
  return {
    actionId: "help",
    status: "ok",
    summary: "Local slash commands.",
    lines: TUI_SLASH_COMMANDS.map((command) => `${command.usage} - ${command.description}`),
  };
}

function buildProvidersSlashResult(dashboard: TuiDashboard): TuiActionResult {
  const profile = dashboard.profile.profile;

  if (!profile) {
    return {
      actionId: "providers",
      status: "failed",
      summary: "Profile is missing.",
      lines: ["Run onboarding from this TUI to configure providers, models, and planner."],
    };
  }

  return {
    actionId: "providers",
    status: "ok",
    summary: `Planner ${profile.planner_provider}/${profile.planner_model}.`,
    lines: [
      `providers ${profile.available_providers.join(",")}`,
      `excluded ${profile.excluded_providers.join(",") || "none"}`,
      `models ${profile.available_models.length ? profile.available_models.join(",") : "default_for_selected_providers"}`,
      `fallback ${profile.routing.allow_provider_fallback ? "enabled" : "disabled"}`,
      `confirmation ${profile.routing.require_confirmation_for_fallback ? "required" : "not_required"}`,
    ],
  };
}

function buildSessionsSlashResult(dashboard: TuiDashboard): TuiActionResult {
  const session = dashboard.agentSession;
  const state = session?.agent_state ?? dashboard.agentState;

  if (!session && !state && !dashboard.chatDraft?.brief) {
    return {
      actionId: "sessions",
      status: "failed",
      summary: "No saved planning session.",
      lines: ["Type a first message to start planning."],
    };
  }

  return {
    actionId: "sessions",
    status: "ok",
    summary: session ? `Saved session ${session.session_id}.` : "Legacy planning draft is available.",
    lines: [
      `messages ${session?.messages.length ?? 0}`,
      `updated ${session?.updated_at ?? "n/a"}`,
      `phase ${state?.project_state.current_phase ?? "draft"}`,
      `next ${state?.next_action.label ?? "resume draft"}`,
      `resume /resume`,
      `clear /clear`,
    ],
  };
}

export function chatRuntimeStatus({
  dashboard,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  isEditingModelPool,
  planChatStep = "idle",
}: {
  dashboard: TuiDashboard;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  isEditingModelPool?: boolean;
  planChatStep?: PlanChatStep;
}): "ready" | "planning" | "running" | "needs-confirmation" | "blocked" {
  if (!dashboard.profile.profile || dashboard.profile.errors.length > 0) {
    return "blocked";
  }

  if (runningAction) {
    return "running";
  }

  if (pendingConfirmation) {
    return "needs-confirmation";
  }

  if (planChatStep !== "idle" || isEditingRevise || isEditingModelPool) {
    return "planning";
  }

  return "ready";
}

function isLandingChatSurface({
  actionResult,
  runningAction,
  hasStartedChatWorkflow = false,
  planChatStep = "idle",
}: {
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  hasStartedChatWorkflow?: boolean;
  planChatStep?: PlanChatStep;
}): boolean {
  return (
    actionResult?.actionId !== "plan"
    && actionResult?.actionId !== "agent-workflow"
    && runningAction !== "agent-workflow"
    && planChatStep === "idle"
    && !hasStartedChatWorkflow
  );
}

export function planStepComplete(draft: PlanChatDraft, step: Exclude<PlanChatStep, "idle">): boolean {
  const value = draft[step];

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return value !== undefined && value !== "";
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
    defaultReasoningEffort: model.default_reasoning_effort,
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
        providerChecks: [],
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
    providerChecks: [],
  };
}

function updatePlanChatDraft(
  draft: PlanChatDraft,
  step: Exclude<PlanChatStep, "idle">,
  value: string,
): PlanChatDraft | undefined {
  if (step === "brief" || step === "projectSummary" || step === "objective") {
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

function firstPlanChatStep(draft: PlanChatDraft): Exclude<PlanChatStep, "idle"> {
  return adaptivePlanChatSteps(draft)[0] ?? "brief";
}

function nextPlanChatStep(
  step: Exclude<PlanChatStep, "idle">,
  draft: PlanChatDraft,
): Exclude<PlanChatStep, "idle"> | undefined {
  const steps = adaptivePlanChatSteps(draft);
  const index = steps.indexOf(step);

  return steps[index + 1];
}

export function adaptivePlanChatSteps(draft: PlanChatDraft): Exclude<PlanChatStep, "idle">[] {
  if (!draft.brief) {
    return [...PLAN_CHAT_STEPS];
  }

  if (!isRichPlanningBrief(draft.brief)) {
    return PLAN_CHAT_STEPS.filter((step) => step !== "brief");
  }

  return [
    "successCriteria",
    "constraints",
    "outOfScope",
    "targetPaths",
    "validationCommands",
    "riskLevel",
    "notes",
  ];
}

function isRichPlanningBrief(brief: string): boolean {
  const normalized = brief.toLowerCase();
  const signals = [
    "objetivo",
    "escopo",
    "critério",
    "criterio",
    "requisito",
    "stack",
    "valid",
    "teste",
    "arquivo",
    "rota",
    "model",
    "provider",
  ];

  return brief.length >= 240 || signals.filter((signal) => normalized.includes(signal)).length >= 3;
}

function inferPlanText(draft: PlanChatDraft, fallback: string): string {
  return truncateLine(draft.brief?.replace(/\s+/gu, " ").trim() || fallback, 160);
}

function buildPlanAnswersFromDraft(draft: PlanChatDraft): PlanAnswers {
  const inferredSummary = inferPlanText(draft, "Planejar trabalho descrito no brief.");

  return {
    projectSummary: draft.projectSummary ?? inferredSummary,
    objective: draft.objective ?? inferredSummary,
    successCriteria: draft.successCriteria ?? [],
    constraints: draft.constraints ?? [],
    outOfScope: draft.outOfScope ?? [],
    targetPaths: draft.targetPaths ?? [],
    validationCommands: draft.validationCommands ?? [],
    riskLevel: draft.riskLevel ?? 5,
    notes: uniqueStrings([...(draft.brief ? [`Initial brief: ${draft.brief}`] : []), ...(draft.notes ?? [])]),
  };
}

export function buildPlanAnswersFromFreeformRequest(brief: string, dashboard: TuiDashboard): PlanAnswers {
  const normalized = brief.replace(/\s+/gu, " ").trim();
  const inferred = truncateLine(normalized, 180);
  const validationCommands = inferTuiValidationCommands(dashboard);

  return {
    projectSummary: inferred,
    objective: inferred,
    successCriteria: ["Planner returns a task graph and exact model assignments for the requested work."],
    constraints: [],
    outOfScope: [],
    targetPaths: [],
    validationCommands,
    riskLevel: inferTuiRiskLevel(normalized),
    notes: [
      "Initial user request was submitted directly from the chat surface.",
      "Do not ask the user to fill a form before planning. Infer missing fields conservatively and ask only if truly blocked.",
      `Initial brief: ${normalized}`,
    ],
  };
}

export function parsePlannerAgentWorkflowState(response: string): PlannerAgentWorkflowState {
  const state = PlannerAgentWorkflowStateSchema.parse(JSON.parse(extractJsonObject(response)));

  if (state.next_action.type === "preview_plan") {
    if (!state.plan_answers) {
      throw new Error("Agent workflow states with next_action.type=preview_plan must include plan_answers.");
    }

    state.plan_answers = parsePlanAnswers(state.plan_answers);
  }

  return state;
}

function parseWorkflowPlanAnswers(state: PlannerAgentWorkflowState): PlanAnswers | undefined {
  if (state.next_action.type !== "preview_plan" || !state.plan_answers) {
    return undefined;
  }

  try {
    return parsePlanAnswers(state.plan_answers);
  } catch {
    return undefined;
  }
}

function buildPlannerAgentWorkflowPrompt({
  request,
  dashboard,
  profile,
  registry,
  reasoningEffort,
}: {
  request: string;
  dashboard: TuiDashboard;
  profile: PlannerProfile;
  registry: ModelRegistryEntry[];
  reasoningEffort?: string;
}): string {
  const activeModels = registry
    .filter((model) => profile.available_models.length === 0 || profile.available_models.includes(model.id))
    .map((model) => ({
      id: model.id,
      provider: model.provider,
      tier: model.tier,
      task_fit: model.task_fit,
      default_reasoning_effort: model.default_reasoning_effort,
      selected_reasoning_effort:
        profile.model_reasoning_efforts[model.id] ?? model.default_reasoning_effort ?? model.reasoning_efforts[0],
      strengths: model.strengths.slice(0, 4),
      avoid_for: model.avoid_for.slice(0, 3),
    }));
  const context = {
    user_request: request,
    root: dashboard.root,
    active_planner: {
      provider: profile.planner_provider,
      model: profile.planner_model,
      reasoning_effort: reasoningEffort,
    },
    project_context: {
      stack: dashboard.doctor.stack,
      canonical_files: dashboard.doctor.canonicalFiles,
      file_count: dashboard.doctor.fileCount,
      manifest_count: dashboard.doctor.manifests.length,
      manifests: dashboard.doctor.manifests.slice(0, PLANNER_CONTEXT_MANIFEST_LIMIT),
      scripts: dashboard.doctor.scripts,
      declared_dependencies: dashboard.doctor.dependencyManifests ?? [],
      top_level_dirs: dashboard.doctor.topLevelDirs,
      inventory_count: dashboard.doctor.inventoryFiles.length,
      inventory_files: dashboard.doctor.inventoryFiles.slice(0, PLANNER_CONTEXT_INVENTORY_LIMIT),
      warnings: dashboard.doctor.warnings,
      existing_tasks: dashboard.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        model: task.suggestedModel,
        risk: task.riskLevel,
      })),
      lint_error_count: dashboard.lint.errors.length,
      lint_warning_count: dashboard.lint.warnings.length,
      lint_errors: dashboard.lint.errors.slice(0, PLANNER_CONTEXT_LINT_LIMIT),
      lint_warnings: dashboard.lint.warnings.slice(0, PLANNER_CONTEXT_LINT_LIMIT),
    },
    previous_session: dashboard.agentSession
      ? {
          session_id: dashboard.agentSession.session_id,
          messages: dashboard.agentSession.messages.slice(-12),
          agent_state: dashboard.agentSession.agent_state,
        }
      : undefined,
    active_models: activeModels,
  };

  return [
    "You are the active planning model inside the Blueprint terminal harness.",
    "The app is a harness: it renders state, but you decide the semantic workflow state.",
    "Do not propose terminal layout, colors, panels, or visual structure.",
    "You control only project understanding, checklist status, questions, validation state, next action, and optional plan answers.",
    "Checkboxes are semantic validation state: mark done only when the supplied project context validates it; otherwise use pending, in_progress, or blocked.",
    "Reiterate the project in your own words, identify what is already known, what still needs validation, and what the next user-facing action should be.",
    "Ask questions only when the workflow is blocked or a decision would be unsafe to infer.",
    "If the user is answering a prior question, update the same session state instead of restarting the workflow.",
    "When setting plan_answers.targetPaths, prefer concrete files and directories from project_context.inventory_files.",
    "Do not invent new source or test directories unless the user explicitly asked for that structure; if a new directory is required, call it out in notes.",
    "Treat project_context.stack as evidence from repository files only, not permission to add frameworks or libraries.",
    "Do not suggest a framework, package, library, build tool, database, or test framework because it is installed globally or available on this computer.",
    "Prefer dependencies already listed in project_context.declared_dependencies or visible project manifests/config files.",
    "If a new dependency or framework seems necessary and the user did not explicitly request it, ask for confirmation or put it in plan_answers.notes as a pending decision instead of making it a settled plan.",
    "When you have enough information to preview the handoffs, set next_action.type to preview_plan and include a valid plan_answers object.",
    "If you cannot include valid plan_answers, do not use preview_plan; use ask_user or continue_planning instead.",
    "Do not generate or write files directly. The app will ask the user for confirmation before previewing or writing artifacts.",
    "Return strict JSON only. No markdown, no prose outside JSON.",
    "JSON schema:",
    JSON.stringify(
      {
        schema_version: "1.0",
        user_request: "original user request",
        planner: {
          provider: profile.planner_provider,
          model: profile.planner_model,
          reasoning_effort: reasoningEffort,
        },
        project_state: {
          title: "short project/work title",
          summary: "your current understanding of what should happen",
          current_phase: "short phase label",
          health: "planning|needs_input|ready_to_preview|blocked",
          confidence: 0.0,
        },
        messages: [{ role: "planner", content: "what you want the user to see in the chat feed" }],
        checklist: [
          {
            id: "understand_request",
            label: "Understand the requested work",
            status: "done|in_progress|pending|blocked",
            validated_by: "active planner model",
            evidence: "why this status is justified",
            interactive: true,
          },
        ],
        questions: [{ id: "q1", question: "question if blocked", why: "why it matters", required: true }],
        next_action: { type: "ask_user|continue_planning|preview_plan", label: "short action", prompt: "optional user prompt" },
        plan_answers: {
          projectSummary: "one-sentence project summary",
          objective: "the concrete delivery to plan",
          successCriteria: ["observable acceptance criterion"],
          constraints: ["technical or business constraint"],
          outOfScope: ["explicitly excluded work"],
          targetPaths: ["relative/path/or/glob"],
          validationCommands: ["command to validate the work"],
          riskLevel: 1,
          notes: ["worker-facing note"],
        },
      },
      null,
      2,
    ),
    "Context:",
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}

async function writePlannerAgentSession(
  rootInput: string,
  currentSession: PlannerAgentSession | undefined,
  userMessage: string,
  state: PlannerAgentWorkflowState,
): Promise<void> {
  const sessionsRoot = path.join(path.resolve(rootInput), BLUEPRINT_DIR, "tui_sessions");
  const now = new Date().toISOString();
  const session = PlannerAgentSessionSchema.parse({
    schema_version: "1.0",
    session_id: currentSession?.session_id ?? randomUUID(),
    updated_at: now,
    messages: [
      ...(currentSession?.messages ?? []),
      {
        role: "user",
        content: userMessage,
        created_at: now,
      },
      ...state.messages.map((message) => ({
        role: "planner" as const,
        content: message.content,
        created_at: now,
      })),
    ],
    agent_state: state,
  });

  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(path.join(sessionsRoot, TUI_AGENT_SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionsRoot, TUI_AGENT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearPlannerAgentSession(rootInput: string): Promise<void> {
  const sessionsRoot = path.join(path.resolve(rootInput), BLUEPRINT_DIR, "tui_sessions");

  await Promise.all([
    rm(path.join(sessionsRoot, TUI_AGENT_SESSION_FILE), { force: true }),
    rm(path.join(sessionsRoot, TUI_AGENT_STATE_FILE), { force: true }),
    rm(path.join(sessionsRoot, "DRAFT.json"), { force: true }),
  ]);
}

function inferTuiValidationCommands(dashboard: TuiDashboard): string[] {
  const scripts = dashboard.doctor.scripts;

  if (scripts.test) {
    return ["corepack pnpm test"];
  }

  if (scripts.check) {
    return ["corepack pnpm check"];
  }

  if (dashboard.doctor.stack.includes("typescript")) {
    return ["corepack pnpm typecheck", "corepack pnpm test"];
  }

  return [];
}

function inferTuiRiskLevel(brief: string): number {
  if (/(auth|pagamento|payment|infra|database|banco|seguran|security|deploy|prod|migra)/iu.test(brief)) {
    return 8;
  }

  if (/(refator|arquitet|fluxo|integra|frontend|backend|api|modelo|provider)/iu.test(brief)) {
    return 6;
  }

  return 4;
}

function parsePlanListInput(value: string): string[] {
  return value
    .split(/[,;\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatProviderCheckLines(results: ProviderDoctorResult[]): string[] {
  if (results.length === 0) {
    return ["provider detection pending"];
  }

  return results.map(
    (result) => `${result.id} ${result.cli} ${result.installed ? "installed" : "missing"} auth ${result.authCheck} ${result.detail}`,
  );
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

export function parseTuiSlashCommandInput(input: string): ParsedTuiSlashCommand | undefined {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [rawCommand = "", ...argumentParts] = trimmed.split(/\s+/u);
  const command = TUI_SLASH_COMMANDS.find((item) => item.command === rawCommand)?.command;

  if (!command) {
    return {
      command: "/help",
      argument: `unknown ${rawCommand}`,
    };
  }

  return {
    command,
    argument: argumentParts.join(" ").trim(),
  };
}

function resolveTuiSlashCommandInput(input: string, selectedIndex: number): ParsedTuiSlashCommand | undefined {
  const parsed = parseTuiSlashCommandInput(input);

  if (!input.trimStart().startsWith("/")) {
    return undefined;
  }

  if (parsed && parsed.command !== "/help") {
    return parsed;
  }

  const suggestions = getSlashCommandSuggestions(input);
  const selected = suggestions[Math.min(selectedIndex, Math.max(suggestions.length - 1, 0))];

  if (!selected) {
    return parsed;
  }

  const [, ...argumentParts] = input.trim().split(/\s+/u);

  return {
    command: selected.command,
    argument: argumentParts.join(" ").trim(),
  };
}

export function getSlashCommandSuggestions(input: string): typeof TUI_SLASH_COMMANDS[number][] {
  const trimmed = input.trimStart();

  if (!trimmed.startsWith("/")) {
    return [];
  }

  const needle = trimmed.split(/\s+/u)[0] ?? "/";

  return TUI_SLASH_COMMANDS.filter((command) => command.command.startsWith(needle));
}

export function getSlashCommandMenuItems(input: string): typeof TUI_SLASH_COMMANDS[number][] {
  return getSlashCommandSuggestions(input);
}

export function currentFocusOverlay({
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  isEditingModelPool,
  modelPoolInput,
  planChatStep = "idle",
  planChatInput,
}: {
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  planChatStep?: PlanChatStep;
  planChatInput?: string;
}): { title: string; body: string; hint: string; color: "cyan" | "yellow" } | undefined {
  if (pendingConfirmation) {
    if (pendingConfirmation === "agent-workflow") {
      return {
        title: "Fallback Ready",
        body: "The primary planner failed, and the next available model is ready to run.",
        hint: "Press y to run the fallback planner, n or Esc to cancel.",
        color: "yellow",
      };
    }

    if (pendingConfirmation === "plan") {
      return {
        title: "Preview Confirmation",
        body: "The planner says the workflow is ready to preview handoffs.",
        hint: "Press y to preview the task graph, n or Esc to keep planning.",
        color: "yellow",
      };
    }

    return {
      title: "Confirmation Overlay",
      body: `Confirm ${pendingConfirmation}?`,
      hint: "Press y to confirm, n or Esc to cancel.",
      color: "yellow",
    };
  }

  if (isEditingModelPool) {
    return {
      title: "Model Pool Overlay",
      body: modelPoolInput?.length ? modelPoolInput : "Type exact model IDs separated by comma, or all.",
      hint: "Enter saves the model pool. Esc cancels.",
      color: "cyan",
    };
  }

  if (isEditingRevise) {
    return {
      title: "Revise Overlay",
      body: reviseInput?.length ? reviseInput : "Describe the targeted change to preview.",
      hint: "Enter previews the revision. Esc cancels.",
      color: "cyan",
    };
  }

  if (planChatStep !== "idle") {
    return {
      title: "Planning Question Overlay",
      body: PLAN_STEP_PROMPTS[planChatStep],
      hint: `Current answer: ${planChatInput || "empty"}`,
      color: "cyan",
    };
  }

  return undefined;
}

export function shouldDisplayTuiActionResult(result: TuiActionResult): boolean {
  return !(result.actionId === "planner-model" && result.status === "ok");
}

function mainMenuIndexForView(view: TuiView): number {
  const index = TUI_MAIN_MENU_ITEMS.findIndex((item) => item.view === view);

  return index === -1 ? 0 : index;
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
      change: options.change?.trim() || options.modelPool?.trim() || options.agentRequest?.trim() || undefined,
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

  if (actionId === "agent-workflow") {
    return "planner agent workflow";
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

  if (actionId === "planner-model") {
    return 'profile planner_model "<id>"';
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function keepIndexVisible(index: number, currentOffset: number, visibleRows: number): number {
  const offset = Math.max(currentOffset, 0);

  if (index < offset) {
    return Math.max(index, 0);
  }

  if (index >= offset + visibleRows) {
    return Math.max(index - visibleRows + 1, 0);
  }

  return offset;
}

function summarizeTuiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/\s+/gu, " ").trim();

  if (!cleaned) {
    return "unknown error";
  }

  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
}

export function truncateLine(line: string, maxWidth: number): string {
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

export function riskIcon(riskLevel: number): string {
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
  isSelectingChatModel,
  chatModelEffortCandidate,
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
  isSelectingChatModel?: boolean;
  chatModelEffortCandidate?: string;
  isEditingRoot?: boolean;
  runningAction?: TuiActionId;
  setupStep?: SetupStep;
}): React.ReactElement {
  let hints: React.ReactNode;

  if (isEditingRoot) {
    hints = "Enter \u2192 open dir  \u2502  Esc \u2192 cancel";
  } else if (!setupInitialized && setupStep !== "idle") {
    hints = "Space \u2192 toggle  \u2502  Enter \u2192 next  \u2502  b \u2192 back  \u2502  Esc \u2192 cancel";
  } else if (chatModelEffortCandidate) {
    hints = "\u2191\u2193 effort  \u2502  Enter confirm  \u2502  b model  \u2502  Esc close";
  } else if (isSelectingChatModel) {
    hints = "\u2191\u2193 model  \u2502  Enter next  \u2502  Esc close";
  } else if (planChatStep !== "idle" || isEditingRevise || isEditingModelPool) {
    hints = "Enter \u2192 submit  \u2502  Esc \u2192 cancel";
  } else if (pendingConfirmation) {
    hints = "y \u2192 confirm  \u2502  n \u2192 cancel";
  } else if (runningAction) {
    hints = `Running ${runningAction}...`;
  } else if (!setupInitialized) {
    hints = "1/Enter \u2192 use current  \u2502  2 \u2192 new folder  \u2502  3/c \u2192 choose dir  \u2502  q quit";
  } else if (view === "main") {
    hints = "\u2191\u2193 select  \u2502  Enter open  \u2502  1-5 open  \u2502  c dir  \u2502  q quit";
  } else if (view === "actions") {
    hints = "esc interrupt  \u2502  tab switch model  \u2502  ctrl+p commands";
  } else {
    hints = "m/Esc menu  \u2502  c dir  \u2502  q quit";
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1 },
    h(Text, { color: "gray" }, hints),
  );
}
