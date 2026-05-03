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
import { initPlannerProfile, loadPlannerProfile, type PlannerProfileValidationResult } from "./profile.js";
import { DEFAULT_PROVIDER_ADAPTERS, checkProviderAuth, type ProviderDoctorResult } from "./providers.js";
import { exportModelRegistry } from "./registry.js";
import { reviseBlueprint, type ReviseResult } from "./revise.js";
import {
  BlueprintManifestSchema,
  BlueprintTaskMetadataSchema,
  DependencyGraphSchema,
  type BlueprintManifest,
  type BlueprintTaskMetadata,
  type DependencyGraph,
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
  exports: string[];
  tuiSessions: string[];
  nextAction: string;
}

export const TUI_ACTION_IDS = ["setup", "lint", "export", "revise", "auth-doctor", "auth-doctor-live"] as const;
export type TuiActionId = (typeof TUI_ACTION_IDS)[number];

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

  return {
    root,
    setup,
    profile,
    doctor,
    lint,
    manifest,
    graph,
    tasks,
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

async function setupBlueprintProject(options: RunTuiActionOptions): Promise<TuiActionResult> {
  const root = path.resolve(options.root);
  const providerResults = options.providerChecker
    ? await options.providerChecker(false)
    : await Promise.all(DEFAULT_PROVIDER_ADAPTERS.map((adapter) => checkProviderAuth(adapter)));
  const providers = chooseSetupProviders(providerResults);
  const plannerProvider = chooseSetupPlanner(providers);
  const initializedFiles = await initBlueprint({ root });
  let profileResult = await loadPlannerProfile(root);
  let createdProfile = false;
  const lines = [
    `providers ${providers.join(",")}`,
    `planner ${plannerProvider}`,
    `blueprint ${initializedFiles.length > 0 ? `created ${initializedFiles.length} file(s)` : "already exists"}`,
  ];

  if (!profileResult.profile) {
    const written = await initPlannerProfile({
      root,
      providers,
      plannerProvider,
      modelRegistrySource: "project",
    });

    createdProfile = written.written;
    lines.push(`${written.written ? "created" : "exists"} ${path.relative(root, written.path)}`);

    for (const warning of written.warnings) {
      lines.push(`warning ${warning}`);
    }
  }

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
  const [isEditingRoot, setIsEditingRoot] = useState(false);
  const [rootInput, setRootInput] = useState(dashboard.root);
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
        const nextRoot = resolveUserRoot(rootInput, dashboardState.root);

        setIsEditingRoot(false);
        setActionResult(undefined);
        setPendingConfirmation(undefined);
        setSelectedActionIndex(0);
        void loadTuiDashboard({ root: nextRoot }).then((nextDashboard) => {
          setDashboardState(nextDashboard);
          setRootInput(nextDashboard.root);
          setView(nextDashboard.setup.initialized ? "overview" : "actions");
        });
        return;
      }

      if (input.length > 0 && !key.ctrl && !key.meta) {
        setRootInput((current) => `${current}${input}`);
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

    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input.toLowerCase() === "c") {
      setRootInput("");
      setIsEditingRoot(true);
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

    if (pendingConfirmation && (view === "actions" || pendingConfirmation === "setup")) {
      if (input.toLowerCase() === "y") {
        void executeAction(pendingConfirmation, {
          apply: pendingConfirmation === "revise",
          change: pendingConfirmation === "revise" ? lastReviseChange : undefined,
        });
      }

      if (input.toLowerCase() === "n") {
        setPendingConfirmation(undefined);
      }

      return;
    }

    if (!dashboardState.setup.initialized && key.return) {
      setView("actions");
      setSelectedActionIndex(0);
      setPendingConfirmation("setup");
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

  async function executeAction(
    actionId: TuiActionId,
    options: { change?: string; apply?: boolean } = {},
  ): Promise<void> {
    setPendingConfirmation(undefined);
    setRunningAction(actionId);
    setActionResult(undefined);

    try {
      const result = await runTuiAction({
        root: dashboardState.root,
        actionId,
        change: options.change,
        apply: options.apply,
      });
      setActionResult(result);

      if (result.actionId === "revise" && result.change) {
        setLastReviseChange(result.change);

        if (result.canApply && !options.apply) {
          setPendingConfirmation("revise");
        }
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
    isEditingRoot,
    rootInput,
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
  isEditingRoot,
  rootInput,
}: {
  dashboard: TuiDashboard;
  view?: TuiView;
  selectedActionIndex?: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  isEditingRoot?: boolean;
  rootInput?: string;
}): React.ReactElement {
  const lintStatus = dashboard.lint.errors.length === 0 ? "ok" : "error";

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { borderStyle: "round", borderColor: lintStatus === "ok" ? "green" : "red", paddingX: 1 },
      h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `${statusIcon(lintStatus === "ok" ? "ok" : "error")} Blueprint TUI`),
        h(Text, null, dashboard.root),
      ),
    ),
    h(TabBar, { activeView: view }),
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
      isEditingRoot,
      rootInput,
    }),
    h(KeyHints, { view, pendingConfirmation, isEditingRevise, isEditingRoot, runningAction }),
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
  isEditingRoot,
  rootInput,
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
  isEditingRoot?: boolean;
  rootInput?: string;
}): React.ReactElement {
  if (isEditingRoot || (!dashboard.setup.initialized && view !== "actions")) {
    return h(SetupView, { dashboard, isEditingRoot, rootInput });
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
    });
  }

  return h(OverviewView, { dashboard, lintStatus });
}

function SetupView({
  dashboard,
  isEditingRoot,
  rootInput,
}: {
  dashboard: TuiDashboard;
  isEditingRoot?: boolean;
  rootInput?: string;
}): React.ReactElement {
  if (isEditingRoot) {
    return h(
      Box,
      { flexDirection: "column", gap: 1 },
      h(
        Box,
        { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
        h(Text, { bold: true }, "Choose Project Directory"),
        h(Text, null, `Current: ${dashboard.root}`),
        h(Text, null, `New path: ${rootInput ?? ""}`),
      ),
      h(
        Box,
        { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
        h(Text, { bold: true }, "Controls"),
        h(Text, null, "Enter opens the typed directory."),
        h(Text, null, "Leave empty and press Enter to keep current."),
        h(Text, null, "Esc cancels."),
      ),
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
      h(Text, { bold: true }, "Choose Directory"),
      h(Text, null, "Enter keeps this directory and starts guided setup."),
      h(Text, null, "Press c to choose another directory."),
    ),
    h(
      Box,
      { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Run these commands"),
      ...dashboard.setup.commands.map((command) => h(Text, { key: command }, command)),
    ),
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
}: {
  dashboard: TuiDashboard;
  selectedActionIndex: number;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
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
    }),
    h(ActionResultPanel, { result: actionResult }),
  );
}

function ActionHint({
  actions,
  selectedActionIndex,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
}: {
  actions: TuiAction[];
  selectedActionIndex: number;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
}): React.ReactElement {
  const selectedAction = actions[selectedActionIndex];
  const message = isEditingRevise
    ? `Change: ${reviseInput ?? ""}`
    : runningAction
    ? `Running ${runningAction}...`
    : pendingConfirmation
      ? `Confirm ${pendingConfirmation}? press y or n.`
      : selectedAction
        ? `${selectedAction.description} Press Enter to run.`
        : "No action selected.";

  return h(
    Box,
    { borderStyle: "single", borderColor: pendingConfirmation || isEditingRevise ? "yellow" : "gray", paddingX: 1 },
    h(Text, null, message),
  );
}

function ActionResultPanel({ result }: { result?: TuiActionResult }): React.ReactElement | null {
  if (!result) {
    return null;
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: result.status === "ok" ? "green" : "red", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, `${result.actionId} ${result.status}`),
    h(Text, null, result.summary),
    ...result.lines.slice(0, 8).map((line) => h(Text, { key: line }, line)),
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

function inferNextAction(input: {
  setup: TuiSetupStatus;
  profile: PlannerProfileValidationResult;
  lint: BlueprintLintResult;
  tasks: TuiTaskSummary[];
  manifest?: BlueprintManifest;
}): string {
  if (!input.setup.initialized) {
    return "Run blueprint init, then blueprint profile init, then blueprint plan.";
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
      "Open the project root or initialize Blueprint here.",
      "Press Enter in this screen to start the guided setup.",
      "Press c to choose another directory.",
    ],
    commands: [
      "blueprint init",
      "blueprint profile init --providers openai,google --planner-provider google --project-registry --force",
      "blueprint plan",
      "blueprint tui",
    ],
  };
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
      change: options.change?.trim() || undefined,
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

  if (actionId === "lint") {
    return "blueprint lint";
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
  pendingConfirmation,
  isEditingRevise,
  isEditingRoot,
  runningAction,
}: {
  view: TuiView;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  isEditingRoot?: boolean;
  runningAction?: TuiActionId;
}): React.ReactElement {
  let hints: string;

  if (isEditingRoot) {
    hints = "Enter \u2192 open dir  \u2502  Esc \u2192 cancel";
  } else if (isEditingRevise) {
    hints = "Enter \u2192 submit  \u2502  Esc \u2192 cancel";
  } else if (pendingConfirmation) {
    hints = "y \u2192 confirm  \u2502  n \u2192 cancel";
  } else if (runningAction) {
    hints = `Running ${runningAction}...`;
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
