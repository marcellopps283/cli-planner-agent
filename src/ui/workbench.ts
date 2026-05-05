import { Box, Text } from "ink";
import path from "node:path";
import React, { createElement } from "react";

import {
  ActionResultPanel,
  ChatModelSelectorPanel,
  OpenCodePathBar,
  SlashCommandPanel,
} from "./panels.js";
import {
  TUI_APP_NAME,
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
  slashCommandCursor = 0,
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
  slashCommandCursor?: number;
  actionResult?: TuiActionResult;
}): React.ReactElement {
  const showSlashMenu = chatCommandInput.trimStart().startsWith("/");

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { flexDirection: "row", gap: 2 },
      h(WorkbenchFeed, { dashboard, actionResult, planChatStep, planChatDraft }),
      h(WorkbenchSidebar, {
        dashboard,
        runningAction,
        pendingConfirmation,
        isEditingRevise,
        isEditingModelPool,
        planChatStep,
      }),
    ),
    h(WorkbenchInputPanel, {
      dashboard,
      chatCommandInput,
      planChatStep,
      planChatInput,
      isEditingRevise,
      reviseInput,
      isEditingModelPool,
      modelPoolInput,
    }),
    ...(showSlashMenu ? [h(SlashCommandPanel, { key: "slash", chatCommandInput, selectedIndex: slashCommandCursor })] : []),
    ...(isSelectingChatModel ? [h(ChatModelSelectorPanel, { key: "model-selector", dashboard, cursor: chatModelCursor })] : []),
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
    { borderStyle: "single", borderColor: "green", paddingX: 1, flexDirection: "column" },
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
    { borderStyle: "single", borderColor: "green", paddingX: 1, flexDirection: "column" },
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
  dashboard,
  chatCommandInput,
  planChatStep,
  planChatInput,
  isEditingRevise,
  reviseInput,
  isEditingModelPool,
  modelPoolInput,
}: {
  dashboard: TuiDashboard;
  chatCommandInput: string;
  planChatStep: PlanChatStep;
  planChatInput: string;
  isEditingRevise?: boolean;
  reviseInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const activeText = planChatStep !== "idle"
    ? planChatInput
    : isEditingRevise
      ? reviseInput ?? ""
      : isEditingModelPool
        ? modelPoolInput ?? ""
        : chatCommandInput;

  return h(
    Box,
    { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
    h(Text, null, h(Text, { color: "cyan" }, "Planner "), h(Text, { bold: true }, profile?.planner_model ?? "missing"), h(Text, { color: "gray" }, ` ${profile?.planner_provider ?? "provider"}`)),
    h(Text, { color: "gray" }, planChatStep !== "idle" ? PLAN_STEP_PROMPTS[planChatStep] : "Type a request, or use /commands."),
    h(Text, null, h(Text, { color: "cyan" }, "> "), activeText),
  );
}

export function WorkbenchSidebar({
  dashboard,
  runningAction,
  pendingConfirmation,
  isEditingRevise,
  isEditingModelPool,
  planChatStep,
}: {
  dashboard: TuiDashboard;
  runningAction?: TuiActionId;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  isEditingModelPool?: boolean;
  planChatStep: PlanChatStep;
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

  const sidebarColor = dashboard.lint.errors.length > 0 
    ? "red" 
    : dashboard.doctor.warnings.length > 0 
      ? "yellow" 
      : dashboard.tasks.length > 0 ? "green" : "gray";

  return h(
    Box,
    { borderStyle: "single", borderColor: sidebarColor, paddingX: 1, flexDirection: "column", width: 34 },
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
    h(Text, { bold: true }, "MCP"),
    ...providers.slice(0, 5).map((provider) =>
      h(Text, { key: `${provider.id}-${provider.cli}`, color: provider.installed ? "green" : "gray" }, `* ${provider.id} ${providerStatusLabel(provider)}`),
    ),
    h(Text, null, ""),
    h(Text, { bold: true }, "LSP"),
    ...stacks.slice(0, 5).map((stack) => h(Text, { key: stack, color: "gray" }, `* ${stack}`)),
    h(Text, null, ""),
    h(Text, { bold: true }, "Todo"),
    ...taskLines.map((line) => h(Text, { key: line, color: line.startsWith("[x]") ? "green" : "gray" }, truncateLine(line, 30))),
  );
}
