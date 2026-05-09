import { Box, Text, useWindowSize } from "ink";
import path from "node:path";
import React, { createElement } from "react";
import Spinner from "ink-spinner";

import { DEFAULT_MODEL_REGISTRY } from "../models.js";
import {
  ChatModelSelectorPanel,
  FocusOverlay,
  OpenCodePathBar,
  ReasoningEffortSelectorPanel,
  SlashCommandPanel,
} from "./panels.js";
import {
  TUI_APP_NAME,
  TUI_MODEL_SELECTOR_VISIBLE_ROWS,
  TUI_SLASH_MENU_VISIBLE_ROWS,
  PLAN_STEP_PROMPTS,
  adaptivePlanChatSteps,
  contextUsePercent,
  estimateContextTokens,
  formatCompactNumber,
  planStepComplete,
  riskIcon,
  truncateLine,
  type PlannerAgentWorkflowState,
  type PlanChatDraft,
  type PlanChatStep,
  type TuiActionId,
  type TuiActionResult,
  type TuiDashboard,
} from "../tui.js";

const h = createElement;
const WORKBENCH_SIDEBAR_WIDTH = 44;
const WORKBENCH_BORDER_COLOR = "gray";
type TimelineColor = "cyan" | "green" | "yellow" | "red" | "gray" | "blue";
type TimelineLine = { key: string; text: string; color?: TimelineColor };
type ChatTranscriptMessage = NonNullable<TuiDashboard["agentSession"]>["messages"][number];
interface TimelineFeedItem {
  key: string;
  rows: number;
  element: React.ReactElement;
}

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
  chatModelEffortCandidate,
  chatModelEffortCursor = 0,
  slashCommandCursor = 0,
  slashCommandScrollOffset = 0,
  actionResult,
  isolateCurrentRun = false,
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
  chatModelEffortCandidate?: string;
  chatModelEffortCursor?: number;
  slashCommandCursor?: number;
  slashCommandScrollOffset?: number;
  actionResult?: TuiActionResult;
  isolateCurrentRun?: boolean;
}): React.ReactElement {
  const showSlashMenu = chatCommandInput.trimStart().startsWith("/");
  const { columns, rows } = useWindowSize();
  const terminalRows = rows > 0 ? rows : process.stdout.rows || 24;
  const terminalColumns = columns > 0 ? columns : process.stdout.columns || 100;
  const feedMaxRows = Math.max(6, terminalRows - workbenchChromeRows({
    pendingConfirmation,
    isEditingRevise,
    isEditingModelPool,
    planChatStep,
  }));
  const timelineWidth = Math.max(32, terminalColumns - WORKBENCH_SIDEBAR_WIDTH - 6);

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1 },
    h(
      Box,
      { flexDirection: "row", flexGrow: 1 },
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, overflow: "hidden" as any },
        h(WorkbenchFeed, {
          dashboard,
          actionResult,
          runningAction,
          planChatStep,
          planChatDraft,
          maxRows: feedMaxRows,
          timelineWidth,
          isolateCurrentRun,
        }),
        h(FocusOverlay, {
          pendingConfirmation,
          isEditingRevise,
          reviseInput,
          isEditingModelPool,
          modelPoolInput,
          planChatStep,
          planChatInput,
        }),
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
        chatModelEffortCandidate,
        chatModelEffortCursor,
      }),
    ),
    h(OpenCodePathBar, { dashboard }),
  );
}

function workbenchChromeRows({
  pendingConfirmation,
  isEditingRevise,
  isEditingModelPool,
  planChatStep,
}: {
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  isEditingModelPool?: boolean;
  planChatStep: PlanChatStep;
}): number {
  const focusRows = pendingConfirmation || isEditingRevise || isEditingModelPool || planChatStep !== "idle" ? 4 : 0;

  return 1 + 4 + focusRows + 1;
}

export function WorkbenchFeed({
  dashboard,
  actionResult,
  runningAction,
  planChatStep,
  planChatDraft,
  maxRows,
  timelineWidth = 92,
  isolateCurrentRun = false,
}: {
  dashboard: TuiDashboard;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  planChatStep: PlanChatStep;
  planChatDraft: PlanChatDraft;
  maxRows?: number;
  timelineWidth?: number;
  isolateCurrentRun?: boolean;
}): React.ReactElement {
  const entries = buildTimelineFeedItems({ dashboard, actionResult, runningAction, planChatStep, planChatDraft, timelineWidth, isolateCurrentRun });
  const visibleEntries = selectVisibleTimelineEntries(entries, maxRows);
  const visibleRows = visibleEntries.reduce((total, item) => total + item.rows, 0);
  const topSpacerRows = maxRows ? Math.max(maxRows - visibleRows, 0) : 0;

  return h(
    Box,
    {
      flexDirection: "column",
      flexGrow: 1,
      justifyContent: "flex-end",
      overflow: "hidden" as any,
      paddingX: 1,
    },
    ...(topSpacerRows > 0 ? [h(Box, { key: "timeline-spacer", height: topSpacerRows, flexShrink: 0 })] : []),
    ...visibleEntries.map((item) => item.element),
  );
}

function buildTimelineFeedItems({
  dashboard,
  actionResult,
  runningAction,
  planChatStep,
  planChatDraft,
  timelineWidth,
  isolateCurrentRun,
}: {
  dashboard: TuiDashboard;
  actionResult?: TuiActionResult;
  runningAction?: TuiActionId;
  planChatStep: PlanChatStep;
  planChatDraft: PlanChatDraft;
  timelineWidth: number;
  isolateCurrentRun: boolean;
}): TimelineFeedItem[] {
  const entries: TimelineFeedItem[] = [];
  const transcript = isolateCurrentRun ? currentRunTranscript(planChatDraft) : chatTranscriptMessages(dashboard);
  const taskCount = dashboard.tasks.length;
  const hasActiveTimelineEvent = planChatStep !== "idle" || Boolean(actionResult);
  const showPersistedArtifacts = !isolateCurrentRun;
  const showPersistedAgentState = !isolateCurrentRun;

  transcript.forEach((message, index) => {
    entries.push({
      key: `chat-${index}-${message.created_at}`,
      rows: estimateTimelineRows([message.content], timelineWidth),
      element: h(ChatMessageBlock, {
        key: `chat-${index}-${message.created_at}`,
        speaker: message.role === "user" ? "You" : "Planner",
        lines: [message.content],
        color: message.role === "user" ? "green" : "cyan",
      }),
    });
  });

  if (showPersistedArtifacts && taskCount > 0 && hasActiveTimelineEvent) {
    entries.push(buildHandoffTimelineItem(dashboard, timelineWidth));
  }

  if (showPersistedAgentState && dashboard.agentState) {
    entries.push({
      key: "agent-state",
      rows: estimateTimelineRows(plannerAgentStateTimelineLines(dashboard.agentState).map((line) => line.text), timelineWidth),
      element: h(PlannerAgentStateBlock, { key: "agent-state", state: dashboard.agentState }),
    });
  }

  if (planChatStep !== "idle") {
    const lines = adaptivePlanChatSteps(planChatDraft).map((step) => PLAN_STEP_PROMPTS[step]);
    entries.push({
      key: "planning",
      rows: estimateTimelineRows(lines, timelineWidth),
      element: h(PlanningProgressBlock, { key: "planning", planChatDraft }),
    });
  }

  if (actionResult?.actionId === "plan" && actionResult.canApply) {
    entries.push({
      key: "preview",
      rows: estimateTimelineRows(actionResult.lines.slice(0, 8), timelineWidth),
      element: h(PlanPreviewBlock, { key: "preview", actionResult }),
    });
  }

  if (actionResult && actionResult.actionId !== "plan") {
    entries.push({
      key: "action-result",
      rows: estimateTimelineRows([actionResult.summary, ...actionResult.lines.slice(0, 6)], timelineWidth),
      element: h(ActionResultArtifactBlock, { key: "action-result", actionResult }),
    });
  }

  if (showPersistedArtifacts && taskCount > 0) {
    if (!hasActiveTimelineEvent) {
      entries.push(buildHandoffTimelineItem(dashboard, timelineWidth));
    }
  } else if (!runningAction && !dashboard.agentState && actionResult?.actionId !== "plan") {
    const lines = ["Send a planning request. Artifacts and todos will appear here as the model progresses."];
    entries.push({
      key: "empty",
      rows: estimateTimelineRows(lines, timelineWidth),
      element: h(EmptyWorkbenchBlock, { key: "empty" }),
    });
  }

  if (runningAction === "agent-workflow") {
    const lines = ["Working · building context, checklist, questions, and next action"];
    entries.push({
      key: "thinking",
      rows: estimateTimelineRows(lines, timelineWidth),
      element: h(PlannerThinkingBlock, { key: "thinking", dashboard }),
    });
  }

  return entries;
}

function currentRunTranscript(planChatDraft: PlanChatDraft): ChatTranscriptMessage[] {
  const brief = planChatDraft.brief?.trim();

  if (!brief) {
    return [];
  }

  return [
    {
      role: "user",
      content: brief,
      created_at: "current-run",
    },
  ];
}

function buildHandoffTimelineItem(dashboard: TuiDashboard, timelineWidth: number): TimelineFeedItem {
  return {
    key: "handoffs",
    rows: estimateTimelineRows([
      `Plan ready. Generated ${dashboard.tasks.length} worker handoff(s).`,
      ...dashboard.tasks.slice(0, 8).map((task) => `${task.id} ${task.suggestedModel}`),
    ], timelineWidth),
    element: h(HandoffReadyBlock, { key: "handoffs", dashboard }),
  };
}

function selectVisibleTimelineEntries(entries: TimelineFeedItem[], maxRows?: number): TimelineFeedItem[] {
  if (!maxRows || entries.length === 0) {
    return entries;
  }

  const selected: TimelineFeedItem[] = [];
  let usedRows = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;

    if (selected.length > 0 && usedRows + entry.rows > maxRows) {
      break;
    }

    selected.unshift(entry);
    usedRows += entry.rows;
  }

  return selected;
}

function estimateTimelineRows(lines: string[], width: number): number {
  const contentWidth = Math.max(width - 4, 24);
  const contentRows = lines.reduce((total, line) => {
    const visualLength = Math.max(line.length, 1);
    return total + Math.max(1, Math.ceil(visualLength / contentWidth));
  }, 0);

  return 1 + contentRows + 1;
}

export function PlannerThinkingBlock({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  const profile = dashboard.profile.profile;
  const meta = profile ? `${profile.planner_provider}/${profile.planner_model}` : "planner model";

  return h(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    h(
      Box,
      { flexDirection: "row" },
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: "cyan" }, "●")),
      h(
        Box,
        { flexGrow: 1 },
        h(Text, null, h(Text, { bold: true, color: "cyan" }, "Planner"), h(Text, { color: "gray" }, ` | ${meta}`)),
      ),
    ),
    h(
      Box,
      { flexDirection: "row" },
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: "gray" }, "│")),
      h(
        Box,
        { flexGrow: 1 },
        h(
          Text,
          null,
          h(Text, { color: "cyan" }, h(Spinner, { type: "dots" }), " Working"),
          h(Text, { color: "gray" }, " · building context, checklist, questions, and next action"),
        ),
      ),
    ),
  );
}

function chatTranscriptMessages(dashboard: TuiDashboard): ChatTranscriptMessage[] {
  const sessionMessages = dashboard.agentSession?.messages ?? [];

  if (sessionMessages.length > 0) {
    return sessionMessages.slice(-12);
  }

  const stateMessages = dashboard.agentState?.messages ?? [];

  return stateMessages.map((message, index) => ({
    role: "planner" as const,
    content: message.content,
    created_at: `legacy-${index}`,
  }));
}

export function PlannerAgentStateBlock({ state }: { state: PlannerAgentWorkflowState }): React.ReactElement {
  const checklistLines = plannerAgentStateTimelineLines(state);

  return h(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    h(InlineArtifactBlock, {
      key: "todo-artifact",
      title: "Updated Plan",
      subtitle: "agent maintained todo",
      lines: checklistLines,
    }),
    ...(state.questions.length > 0
      ? [
          h(InlineArtifactBlock, {
            key: "questions-artifact",
            title: "Questions",
            subtitle: "needs user input",
            lines: state.questions.slice(0, 4).map((question) => ({
              key: question.id,
              color: "yellow" as const,
              text: `? ${question.question}`,
            })),
          }),
        ]
      : []),
  );
}

function plannerAgentStateTimelineLines(state: PlannerAgentWorkflowState): TimelineLine[] {
  const confidence = `${Math.round(state.project_state.confidence * 100)}%`;

  return [
    {
      key: "title",
      color: "gray",
      text: state.project_state.title,
    },
    {
      key: "phase",
      color: "gray",
      text: `${state.project_state.current_phase} / ${state.project_state.health} / confidence ${confidence}`,
    },
    {
      key: "summary",
      color: "gray",
      text: state.project_state.summary,
    },
    {
      key: "next",
      color: state.project_state.health === "ready_to_preview" ? "green" : "yellow",
      text: `Next: ${state.next_action.label}`,
    },
    ...state.checklist.slice(0, 10).map((item): TimelineLine => ({
      key: item.id,
      color: agentChecklistColor(item.status),
      text: `${agentCheckbox(item.status)} ${item.label}${item.evidence ? ` - ${item.evidence}` : ""}`,
    })),
  ];
}

function agentCheckbox(status: PlannerAgentWorkflowState["checklist"][number]["status"]): string {
  if (status === "done") {
    return "[x]";
  }

  if (status === "in_progress") {
    return "[~]";
  }

  if (status === "blocked") {
    return "[!]";
  }

  return "[ ]";
}

function agentChecklistColor(status: PlannerAgentWorkflowState["checklist"][number]["status"]): "green" | "yellow" | "red" | "gray" {
  if (status === "done") {
    return "green";
  }

  if (status === "in_progress") {
    return "yellow";
  }

  if (status === "blocked") {
    return "red";
  }

  return "gray";
}

interface ParsedPreviewTaskLine {
  id: string;
  model: string;
  risk: number;
  deps: string;
  paths: string;
  reason: string;
}

function parsePreviewTaskLine(line: string): ParsedPreviewTaskLine {
  const parsed =
    /^(task-\d{3}-\S+)\s+model\s+(\S+)\s+risk\s+(\d+)\s+deps\s+(.+?)\s+paths\s+(.+?)\s+alternatives\s+(.+?)\s+reason\s+(.+)$/u.exec(
      line,
    );

  if (!parsed) {
    return {
      id: line.split(/\s+/u)[0] ?? "task",
      model: "unknown",
      risk: 5,
      deps: "unknown",
      paths: "unknown",
      reason: truncateLine(line, 94),
    };
  }

  return {
    id: parsed[1]!,
    model: parsed[2]!,
    risk: Number(parsed[3]),
    deps: parsed[4]!,
    paths: parsed[5]!,
    reason: parsed[7]!,
  };
}

export function PlanningProgressBlock({ planChatDraft }: { planChatDraft: PlanChatDraft }): React.ReactElement {
  return h(InlineArtifactBlock, {
    title: "Planning Intake",
    subtitle: "draft answers",
    lines: adaptivePlanChatSteps(planChatDraft).map((step) => ({
      key: step,
      color: planStepComplete(planChatDraft, step) ? "green" as const : "gray" as const,
      text: `${planStepComplete(planChatDraft, step) ? "[x]" : "[ ]"} ${PLAN_STEP_PROMPTS[step]}`,
    })),
  });
}

export function PlanPreviewBlock({ actionResult }: { actionResult: TuiActionResult }): React.ReactElement {
  const tasks = actionResult.lines
    .filter((line) => line.startsWith("task-"))
    .map(parsePreviewTaskLine)
    .slice(0, 6);

  return h(TimelineEntryBlock, {
    marker: "◇",
    title: "Created Artifact: Preview Contract",
    meta: actionResult.summary,
    color: "cyan",
    lines: [
      ...(tasks.length > 0
        ? tasks.flatMap((task): TimelineLine[] => [
            {
              key: `${task.id}-title`,
              color: task.risk >= 7 ? "red" : task.risk >= 5 ? "yellow" : "green",
              text: `${riskIcon(task.risk)} ${task.id} | ${task.model} | risk ${task.risk}`,
            },
            {
              key: `${task.id}-deps`,
              color: "gray",
              text: `deps ${task.deps} | paths ${truncateLine(task.paths, 72)}`,
            },
            {
              key: `${task.id}-reason`,
              color: "gray",
              text: truncateLine(task.reason, 94),
            },
          ])
        : [{ key: "pending", text: "[ ] waiting for preview tasks" }]),
      { key: "confirm", color: "cyan", text: "Confirm to write this preview to .blueprint/." },
    ],
  });
}

export function HandoffReadyBlock({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  return h(TimelineEntryBlock, {
    marker: "◇",
    title: "Created Artifacts: Handoffs Ready",
    meta: `Plan ready. Generated ${dashboard.tasks.length} worker handoff(s).`,
    color: "green",
    lines: [
      ...dashboard.tasks.slice(0, 8).map((task): TimelineLine => ({
        key: task.id,
        color: "green",
        text: `[x] ${task.id} | ${task.suggestedModel} | risk ${task.riskLevel} | deps ${task.dependencies.length ? task.dependencies.join(",") : "none"}`,
      })),
      ...(dashboard.tasks.length > 8
        ? [{ key: "more", color: "gray" as const, text: `+${dashboard.tasks.length - 8} more task(s)` }]
        : []),
    ],
  });
}

export function EmptyWorkbenchBlock(): React.ReactElement {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(ChatMessageBlock, {
      speaker: "Planner",
      muted: "ready",
      lines: ["Send a planning request. Artifacts and todos will appear here as the model progresses."],
    }),
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
  const hint = planChatStep !== "idle"
    ? PLAN_STEP_PROMPTS[planChatStep]
    : dashboard.agentState
      ? dashboard.agentState.next_action.prompt ?? "Respond to the active planner workflow, or use /commands."
      : "Type a request, or use /commands.";

  return h(
    Box,
    { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
    h(Text, { color: "gray" }, hint),
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
  chatModelEffortCandidate,
  chatModelEffortCursor = 0,
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
  chatModelEffortCandidate?: string;
  chatModelEffortCursor?: number;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const contextTokens = estimateContextTokens(dashboard);
  const contextPercent = contextUsePercent(dashboard);
  const taskLines = sidebarTodoLines(dashboard);
  const effortModel = chatModelEffortCandidate
    ? DEFAULT_MODEL_REGISTRY.find((model) => model.id === chatModelEffortCandidate)
    : undefined;

  if (effortModel) {
    return h(ReasoningEffortSelectorPanel, {
      modelId: effortModel.id,
      provider: effortModel.provider,
      efforts: effortModel.reasoning_efforts,
      cursor: chatModelEffortCursor,
      currentEffort: profile?.model_reasoning_efforts[effortModel.id],
      width: WORKBENCH_SIDEBAR_WIDTH,
    });
  }

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

  const sidebarStatusColor = dashboard.lint.errors.length > 0
    ? "red"
    : dashboard.doctor.warnings.length > 0
      ? "yellow"
      : dashboard.tasks.length > 0 ? "green" : "gray";

  return h(
    Box,
    { borderStyle: "single", borderColor: WORKBENCH_BORDER_COLOR, paddingX: 1, flexDirection: "column", width: WORKBENCH_SIDEBAR_WIDTH },
    h(Text, { bold: true }, truncateLine(path.basename(dashboard.root) || TUI_APP_NAME, 32)),
    h(Text, null, ""),
    h(Text, { bold: true }, "Context"),
    h(Text, { color: "gray" }, `${formatCompactNumber(contextTokens)} tokens`),
    h(Text, { color: "gray" }, `${contextPercent}% used`),
    h(Text, { color: sidebarStatusColor }, dashboard.doctor.warnings.length > 0 ? `${dashboard.doctor.warnings.length} context warning(s)` : "context clean"),
    h(Text, { color: dashboard.tasks.length > 0 ? "green" : "gray" }, `${dashboard.tasks.length} artifact task(s)`),
    h(Text, null, ""),
    h(Text, { bold: true }, "Todo"),
    ...taskLines.map((line) => h(Text, { key: line.text, color: line.color }, line.text)),
  );
}

function ChatMessageBlock({
  speaker,
  muted,
  title,
  lines,
  color = "cyan",
}: {
  speaker: string;
  muted?: string;
  title?: string;
  lines: string[];
  color?: TimelineColor;
}): React.ReactElement {
  return h(TimelineEntryBlock, {
    marker: "●",
    title: title ? `${speaker} · ${title}` : speaker,
    meta: muted,
    color,
    lines: lines.map((line, index) => ({
      key: `${speaker}-${index}`,
      color: index === 0 ? undefined : "gray" as const,
      text: line,
    })),
  });
}

function InlineArtifactBlock({
  title,
  subtitle,
  lines,
}: {
  title: string;
  subtitle?: string;
  lines: TimelineLine[];
}): React.ReactElement {
  return h(TimelineEntryBlock, {
    marker: "◇",
    title: `Artifact: ${title}`,
    meta: subtitle,
    color: "cyan",
    lines,
  });
}

function TimelineEntryBlock({
  marker,
  title,
  meta,
  lines,
  color = "cyan",
}: {
  marker: string;
  title: string;
  meta?: string;
  lines: TimelineLine[];
  color?: TimelineColor;
}): React.ReactElement {
  return h(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    h(
      Box,
      { flexDirection: "row" },
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color }, marker)),
      h(
        Box,
        { flexGrow: 1 },
        h(
          Text,
          null,
          h(Text, { bold: true, color }, title),
          ...(meta ? [h(Text, { key: "meta", color: "gray" }, ` | ${meta}`)] : []),
        ),
      ),
    ),
    ...lines.map((line) =>
      h(
        Box,
        { key: line.key, flexDirection: "row" },
        h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: "gray" }, "│")),
        h(Box, { flexGrow: 1 }, h(Text, { color: line.color }, line.text)),
      ),
    ),
  );
}

function ActionResultArtifactBlock({ actionResult }: { actionResult: TuiActionResult }): React.ReactElement {
  const color: TimelineColor = actionResult.status === "ok" ? "green" : actionResult.status === "needs-confirmation" ? "yellow" : "red";

  return h(InlineArtifactBlock, {
    title: "Action Result",
    subtitle: actionResult.actionId,
    lines: [
      { key: "summary", color, text: actionResult.summary },
      ...actionResult.lines.slice(0, 6).map((line, index) => ({
        key: `line-${index}`,
        color: "gray" as const,
        text: line,
      })),
    ],
  });
}

function sidebarTodoLines(dashboard: TuiDashboard): Array<{ text: string; color: "green" | "yellow" | "red" | "gray" }> {
  if (dashboard.tasks.length > 0) {
    return dashboard.tasks.slice(0, 8).map((task) => ({
      text: `[x] ${task.title} r${task.riskLevel}`,
      color: "green",
    }));
  }

  const state = dashboard.agentState;

  if (state?.checklist.length) {
    return state.checklist.slice(0, 10).map((item) => ({
      text: `${agentCheckbox(item.status)} ${item.label}`,
      color: agentChecklistColor(item.status),
    }));
  }

  return [{ text: "[ ] Generate first blueprint", color: "gray" }];
}
