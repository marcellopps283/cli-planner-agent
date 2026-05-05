import { Box, Text } from "ink";
import path from "node:path";
import React, { createElement } from "react";

import {
  ActionResultPanel,
  ChatModelSelectorPanel,
  FocusOverlay,
  OpenCodePathBar,
  SlashCommandPanel,
} from "./panels.js";
import {
  TUI_APP_NAME,
  TUI_MODEL_SELECTOR_VISIBLE_ROWS,
  TUI_SLASH_MENU_VISIBLE_ROWS,
  PLAN_STEP_PROMPTS,
  type PlanChatDraft,
  type PlanChatStep,
  type TuiActionId,
  type TuiActionResult,
  type TuiDashboard,
  adaptivePlanChatSteps,
  chatRuntimeStatus,
  contextUsePercent,
  estimateContextTokens,
  formatCompactNumber,
  planStepComplete,
  providerStatusLabel,
  riskIcon,
  runtimeStatusColor,
  truncateLine,
} from "../tui.js";

const h = createElement;
const WORKBENCH_SIDEBAR_WIDTH = 44;

export function WorkbenchSurface({
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
  chatModelCursor = 0,
  chatModelScrollOffset = 0,
  slashCommandCursor = 0,
  slashCommandScrollOffset = 0,
  actionResult,
}: {
  dashboard: TuiDashboard;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  chatCommandInput: string;
  planChatStep: PlanChatStep;
  planChatDraft: PlanChatDraft;
  planChatInput: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  chatModelScrollOffset?: number;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
  actionResult?: TuiActionResult;
}): React.ReactElement {
  const showSlashMenu = chatCommandInput.trimStart().startsWith("/");

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1 },
    h(
      Box,
      { flexDirection: "row", gap: 2, flexGrow: 1 },
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, gap: 1, paddingBottom: 1 },
        h(WorkbenchFeed, { dashboard, actionResult, planChatStep, planChatDraft }),
        h(FocusOverlay, {
          pendingConfirmation,
          isEditingRevise,
          reviseInput,
          isEditingModelPool,
          modelPoolInput,
          planChatStep,
          planChatInput,
        }),
        h(ActionResultPanel, { result: actionResult }),
        h(WorkbenchInputPanel, {
          chatCommandInput,
          planChatStep,
          planChatInput,
          isEditingRevise,
          reviseInput,
          isEditingModelPool,
          modelPoolInput,
        }),
      ),
      h(WorkbenchSidebar, {
        dashboard,
        runningAction,
        pendingConfirmation,
        isEditingRevise,
        isEditingModelPool,
        planChatStep,
        showSlashMenu,
        chatCommandInput,
        slashCommandCursor,
        slashCommandScrollOffset,
        isSelectingChatModel,
        chatModelCursor,
        chatModelScrollOffset,
      }),
    ),
    h(OpenCodePathBar, { dashboard }),
  );
}

export function WorkbenchFeed({
  dashboard,
  actionResult,
  planChatStep,
  planChatDraft,
}: {
  dashboard: TuiDashboard;
  actionResult?: TuiActionResult;
  planChatStep: PlanChatStep;
  planChatDraft: PlanChatDraft;
}): React.ReactElement {
  const taskCount = dashboard.tasks.length;

  return h(
    Box,
    { flexDirection: "column", gap: 1, flexGrow: 1 },
    h(Text, { color: "gray" }, dashboard.nextAction),
    ...(planChatStep !== "idle"
      ? [h(PlanningProgressBlock, { key: "planning", planChatDraft })]
      : []),
    ...(actionResult?.actionId === "plan" && actionResult.canApply
      ? [h(PlanPreviewBlock, { key: "preview", actionResult })]
      : []),
    ...(taskCount > 0
      ? [h(HandoffReadyBlock, { key: "handoffs", dashboard })]
      : actionResult?.actionId !== "plan"
        ? [h(EmptyWorkbenchBlock, { key: "empty" })]
        : []),
  );
}

export function PlanningProgressBlock({ planChatDraft }: { planChatDraft: PlanChatDraft }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: "blue", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Planning Intake"),
    ...adaptivePlanChatSteps(planChatDraft).map((step) =>
      h(Text, { key: step }, `${planStepComplete(planChatDraft, step) ? "[x]" : "[ ]"} ${PLAN_STEP_PROMPTS[step]}`),
    ),
  );
}

export function PlanPreviewBlock({ actionResult }: { actionResult: TuiActionResult }): React.ReactElement {
  const taskLines = actionResult.lines.filter((line) => line.startsWith("task-")).slice(0, 6);

  return h(
    Box,
    { borderStyle: "single", borderColor: "blue", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Plan Preview Ready"),
    h(Text, null, actionResult.summary),
    ...(taskLines.length > 0
      ? taskLines.map((line) => h(Text, { key: line }, `[ ] ${truncateLine(line, 110)}`))
      : [h(Text, { key: "pending" }, "[ ] waiting for preview tasks")]),
    h(Text, { color: "gray" }, "Confirm to write .blueprint artifacts."),
  );
}

export function HandoffReadyBlock({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Background Task Completed"),
    h(Text, null, `Generated ${dashboard.tasks.length} planner handoff(s).`),
    ...dashboard.tasks.slice(0, 8).map((task) =>
      h(
        Text,
        { key: task.id },
        `[x] ${task.id} | ${task.suggestedModel} | deps ${task.dependencies.length ? task.dependencies.join(",") : "none"}`,
      ),
    ),
    ...(dashboard.tasks.length > 8 ? [h(Text, { key: "more", color: "gray" }, `+${dashboard.tasks.length - 8} more task(s)`)] : []),
  );
}

export function EmptyWorkbenchBlock(): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Blueprint Artifact"),
    h(Text, { color: "gray" }, "[ ] waiting for the first planning request"),
  );
}

export function WorkbenchInputPanel({
  chatCommandInput,
  planChatStep,
  planChatInput,
  isEditingRevise,
  reviseInput,
  isEditingModelPool,
  modelPoolInput,
}: {
  chatCommandInput: string;
  planChatStep: PlanChatStep;
  planChatInput: string;
  isEditingRevise?: boolean;
  reviseInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
}): React.ReactElement {
  const activeText = planChatStep !== "idle"
    ? planChatInput
    : isEditingRevise
      ? reviseInput ?? ""
      : isEditingModelPool
        ? modelPoolInput ?? ""
        : chatCommandInput;

  return h(
    Box,
    { borderStyle: "single", borderColor: "blue", paddingX: 1, flexDirection: "column" },
    h(Text, { color: "gray" }, planChatStep !== "idle" ? PLAN_STEP_PROMPTS[planChatStep] : "Type a request, or use /commands."),
    h(Text, null, h(Text, { color: "blue" }, "❯ "), activeText, h(Text, { inverse: true }, " ")),
  );
}

export function WorkbenchSidebar({
  dashboard,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  isEditingModelPool,
  planChatStep,
  showSlashMenu,
  chatCommandInput = "",
  slashCommandCursor = 0,
  slashCommandScrollOffset = 0,
  isSelectingChatModel,
  chatModelCursor = 0,
  chatModelScrollOffset = 0,
}: {
  dashboard: TuiDashboard;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  isEditingModelPool?: boolean;
  planChatStep: PlanChatStep;
  showSlashMenu?: boolean;
  chatCommandInput?: string;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  chatModelScrollOffset?: number;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const contextTokens = estimateContextTokens(dashboard);
  const contextPercent = contextUsePercent(dashboard);
  const providers = dashboard.setup.providerChecks.length > 0
    ? dashboard.setup.providerChecks
    : profile?.available_providers.map((provider) => ({ id: provider, cli: provider, installed: true, authCheck: "not_checked" as const, detail: "profile" })) ?? [];
  const stacks = dashboard.doctor.stack.length > 0 ? dashboard.doctor.stack : ["unknown"];
  const taskLines = dashboard.tasks.length > 0
    ? dashboard.tasks.slice(0, 5).map((task) => `[x] ${task.title}`)
    : ["[ ] Generate first blueprint"];

  if (isSelectingChatModel) {
    return h(ChatModelSelectorPanel, {
      dashboard,
      cursor: chatModelCursor,
      scrollOffset: chatModelScrollOffset,
      maxVisible: TUI_MODEL_SELECTOR_VISIBLE_ROWS,
      maxLineWidth: 38,
      width: WORKBENCH_SIDEBAR_WIDTH,
    });
  }

  if (showSlashMenu) {
    return h(SlashCommandPanel, {
      chatCommandInput,
      selectedIndex: slashCommandCursor,
      scrollOffset: slashCommandScrollOffset,
      maxVisible: TUI_SLASH_MENU_VISIBLE_ROWS,
      maxLineWidth: 38,
      width: WORKBENCH_SIDEBAR_WIDTH,
    });
  }

  const sidebarColor = dashboard.lint.errors.length > 0
    ? "red"
    : dashboard.doctor.warnings.length > 0
      ? "yellow"
      : dashboard.tasks.length > 0 ? "green" : "gray";

  return h(
    Box,
    { borderStyle: "single", borderColor: sidebarColor, paddingX: 1, flexDirection: "column", width: WORKBENCH_SIDEBAR_WIDTH },
    h(Text, { bold: true }, path.basename(dashboard.root) || TUI_APP_NAME),
    h(Text, null, ""),
    h(Text, { bold: true }, "Context"),
    h(Text, { color: "gray" }, `${formatCompactNumber(contextTokens)} tokens`),
    h(Text, { color: "gray" }, `${contextPercent}% used`),
    h(Text, { color: "gray" }, "quota n/a"),
    h(Text, null, ""),
    h(Text, { bold: true }, "Status"),
    h(Text, { color: runtimeStatusColor(chatRuntimeStatus({ dashboard, runningAction, pendingConfirmation, isEditingRevise, isEditingModelPool, planChatStep })) }, chatRuntimeStatus({ dashboard, runningAction, pendingConfirmation, isEditingRevise, isEditingModelPool, planChatStep })),
    h(Text, null, ""),
    h(Text, { bold: true }, "Providers"),
    ...providers.slice(0, 5).map((provider) =>
      h(Text, { key: `${provider.id}-${provider.cli}`, color: provider.installed ? "green" : "gray" }, `* ${provider.id} ${providerStatusLabel(provider)}`),
    ),
    h(Text, null, ""),
    h(Text, { bold: true }, "Stack"),
    ...stacks.slice(0, 5).map((stack) => h(Text, { key: stack, color: "gray" }, `* ${stack}`)),
    h(Text, null, ""),
    h(Text, { bold: true }, "Planner"),
    h(Text, { color: "gray" }, profile ? `${profile.planner_provider}/${profile.planner_model}` : "missing"),
    h(Text, null, ""),
    h(Text, { bold: true }, "Todo"),
    ...taskLines.map((line) => h(Text, { key: line, color: line.startsWith("[x]") ? "green" : "gray" }, truncateLine(line, 30))),
  );
}
