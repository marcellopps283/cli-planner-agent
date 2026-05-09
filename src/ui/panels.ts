import { Box, Text, useWindowSize } from "ink";
import React, { createElement } from "react";

import {
  TUI_APP_NAME,
  TUI_APP_VERSION,
  type TuiActionId,
  type TuiActionResult,
  type TuiDashboard,
  type PlanChatStep,
  chatModelsForConnectedProvider,
  currentFocusOverlay,
  getSlashCommandMenuItems,
} from "../tui.js";

const h = createElement;
const PANEL_BORDER_COLOR = "gray";

export function ActionResultPanel({ result }: { result?: TuiActionResult }): React.ReactElement | null {
  if (!result) {
    return null;
  }

  const statusColor = result.status === "ok" ? "green" : result.status === "needs-confirmation" ? "yellow" : "red";
  const visibleLines = result.lines.slice(0, 8);
  const hiddenCount = result.lines.length - visibleLines.length;

  return h(
    Box,
    { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true, color: statusColor }, `${result.actionId} ${result.status}`),
    h(Text, null, result.summary),
    ...visibleLines.map((line) => h(Text, { key: line }, line)),
    ...(hiddenCount > 0 ? [h(Text, { key: "more", color: "gray" }, `+${hiddenCount} more line(s)`)] : []),
    ...(result.sessionPath ? [h(Text, { key: "session" }, `session ${result.sessionPath}`)] : []),
  );
}

export function OpenCodePathBar({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  const modelLabel = plannerRuntimeLabel(dashboard);
  const folder = folderLabel(dashboard.root);
  const { columns } = useWindowSize();
  const terminalColumns = columns > 0 ? columns : process.stdout.columns || 100;
  const folderWidth = terminalColumns < 88 ? 16 : 22;
  const hint = `tab model | / commands | v${TUI_APP_VERSION}`;
  const modelWidth = Math.max(18, Math.min(42, terminalColumns - folderWidth - hint.length - 8));

  return h(
    Box,
    { overflowX: "hidden" as any, width: terminalColumns },
    h(
      Text,
      { color: "gray", wrap: "truncate" },
      `${truncateText(folder, folderWidth)} | `,
      h(Text, { color: modelLabel === "planner missing" ? "yellow" : "cyan" }, truncateText(modelLabel, modelWidth)),
      ` | ${hint}`,
    ),
  );
}

function plannerRuntimeLabel(dashboard: TuiDashboard): string {
  const profile = dashboard.profile.profile;

  if (!profile) {
    return "planner missing";
  }

  const model = profile.planner_model;
  const effort =
    profile.planner_reasoning_effort
    ?? profile.model_reasoning_efforts[model]
    ?? dashboard.registryModels.find((candidate) => candidate.id === model)?.defaultReasoningEffort;
  const provider = providerDisplayName(profile.planner_provider);

  return `${provider}/${model}${effort ? `-${effort}` : ""}`;
}

function providerDisplayName(provider: string): string {
  if (provider === "openai") {
    return "OpenAI";
  }

  if (provider === "google") {
    return "Gemini";
  }

  if (provider === "anthropic") {
    return "Claude";
  }

  return provider;
}

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }

  return `${text.slice(0, Math.max(maxWidth - 1, 0))}…`;
}

function folderLabel(root: string): string {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root;
}

export function MessageList({ title, messages }: { title: string; messages: string[] }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: messages.length > 0 ? "yellow" : "green", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, title),
    ...(messages.length > 0 ? messages : ["none"]).map((message) => h(Text, { key: message }, message)),
  );
}

export function EmptyPanel({ title, message }: { title: string; message: string }): React.ReactElement {
  return h(
    Box,
    { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, title),
    h(Text, null, message),
  );
}

export function ChatModelSelectorPanel({
  dashboard,
  cursor,
  maxLineWidth = 96,
  width,
}: {
  dashboard: TuiDashboard;
  cursor: number;
  scrollOffset?: number;
  maxVisible?: number;
  maxLineWidth?: number;
  width?: number;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const models = chatModelsForConnectedProvider(dashboard);
  const selectedIndex = Math.min(cursor, Math.max(models.length - 1, 0));
  const provider = profile?.planner_provider ?? "missing";
  const selectedModel = models[selectedIndex];

  if (!profile) {
    return h(
      Box,
      { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column", width },
      h(Text, { bold: true }, "Model Selector"),
      h(Text, null, "Profile is missing. Run setup before selecting a chat model."),
    );
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column", width },
    h(Text, { bold: true }, "Model Selector"),
    h(Text, { color: "gray" }, `Connected CLI: ${provider}. Step 1/2 chooses the chat model.`),
    ...(selectedModel
      ? [
          h(Text, { key: "position", color: "gray" }, `Model ${selectedIndex + 1}/${models.length}`),
          h(
            Text,
            {
              key: selectedModel.id,
              color: selectedModel.id === profile.planner_model ? "green" : "cyan",
              bold: true,
              wrap: "truncate",
            },
            truncatePanelLine(`> ${selectedModel.id}${selectedModel.id === profile.planner_model ? " (current)" : ""}`, maxLineWidth),
          ),
          h(Text, { key: "meta" }, `${selectedModel.tier}/${selectedModel.status}`),
          h(Text, { key: "effort" }, `Default effort: ${selectedModel.defaultReasoningEffort ?? "auto"}`),
          h(Text, { key: "hint", color: "gray" }, "Up/down changes model. Enter opens effort. Esc closes."),
        ]
      : [h(Text, { key: "empty", color: "yellow" }, `No models found for ${provider}. Refresh the registry or update the provider pool.`)]),
  );
}

export function SlashCommandPanel({
  chatCommandInput,
  landing = false,
  selectedIndex = 0,
  scrollOffset = 0,
  maxVisible = 6,
  maxLineWidth = 96,
  width,
}: {
  chatCommandInput: string;
  landing?: boolean;
  selectedIndex?: number;
  scrollOffset?: number;
  maxVisible?: number;
  maxLineWidth?: number;
  width?: number;
}): React.ReactElement {
  const suggestions = getSlashCommandMenuItems(chatCommandInput);
  const isFiltering = chatCommandInput.trim().startsWith("/");

  if (!isFiltering) {
    return h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1, width },
      h(
        Text,
        { color: "gray" },
        landing
          ? "Type / to configure providers, models, auth, registry, or help."
          : "Type / for commands, /menu for navigation, /help for the full command list.",
      ),
    );
  }

  const commandsToRender = suggestions;
  const activeIndex = Math.min(selectedIndex, Math.max(commandsToRender.length - 1, 0));
  const safeOffset = clampScrollOffset(scrollOffset, commandsToRender.length, maxVisible);
  const visibleCommands = commandsToRender.slice(safeOffset, safeOffset + maxVisible);

  return h(
    Box,
    { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column", width },
    h(Text, { bold: true }, isFiltering ? "Slash Autocomplete" : "Slash Commands"),
    ...(isFiltering ? [h(Text, { key: "tab-hint", color: "gray" }, "Use \u2191\u2193 to choose. Tab completes. Enter runs selected command.")] : []),
    ...(visibleCommands.length > 0
      ? visibleCommands.map((command, index) => {
          const absoluteIndex = safeOffset + index;
          const line = `${absoluteIndex === activeIndex && isFiltering ? "> " : "  "}${command.usage} | ${command.description}`;

          return h(
            Text,
            {
              key: command.command,
              color: isFiltering && absoluteIndex === activeIndex ? "cyan" : undefined,
              wrap: "truncate",
            },
            truncatePanelLine(line, maxLineWidth),
          );
        })
      : [h(Text, { key: "empty", color: "yellow" }, "No matching slash command.")]),
    ...(commandsToRender.length > maxVisible
      ? [
          h(
            Text,
            { key: "scroll", color: "gray" },
            `↑↓ scroll ${safeOffset + 1}-${safeOffset + visibleCommands.length}/${commandsToRender.length}`,
          ),
        ]
      : []),
  );
}

export function ReasoningEffortSelectorPanel({
  modelId,
  provider,
  efforts,
  cursor,
  currentEffort,
  width,
}: {
  modelId: string;
  provider: string;
  efforts: string[];
  cursor: number;
  currentEffort?: string;
  width?: number;
}): React.ReactElement {
  const selectedIndex = Math.min(cursor, Math.max(efforts.length - 1, 0));
  const selectedEffort = efforts[selectedIndex];

  return h(
    Box,
    { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column", width },
    h(Text, { bold: true }, "Reasoning Effort"),
    h(Text, { color: "gray" }, `Step 2/2: ${provider.toUpperCase()}/${modelId}`),
    ...(selectedEffort
      ? [
          h(Text, { key: "position", color: "gray" }, `Effort ${selectedIndex + 1}/${efforts.length}`),
          h(
            Text,
            {
              key: selectedEffort,
              color: selectedEffort === currentEffort ? "green" : "cyan",
              bold: true,
            },
            `> ${selectedEffort}${selectedEffort === currentEffort ? " current" : ""}`,
          ),
          h(Text, { key: "current" }, `Current: ${currentEffort ?? "default"}`),
        ]
      : [h(Text, { key: "empty", color: "yellow" }, "This model does not expose effort levels.")]),
    h(Text, { color: "gray" }, "Up/down selects, Enter confirms, b returns, Esc closes."),
  );
}

function clampScrollOffset(scrollOffset: number, itemCount: number, maxVisible: number): number {
  return Math.min(Math.max(scrollOffset, 0), Math.max(itemCount - maxVisible, 0));
}

function truncatePanelLine(line: string, maxLineWidth: number): string {
  if (line.length <= maxLineWidth) {
    return line;
  }

  return `${line.slice(0, Math.max(maxLineWidth - 1, 0))}…`;
}

export function FocusOverlay({
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
}): React.ReactElement | null {
  const state = currentFocusOverlay({
    pendingConfirmation,
    isEditingRevise,
    reviseInput,
    isEditingModelPool,
    modelPoolInput,
    planChatStep,
    planChatInput,
  });

  if (!state) {
    return null;
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: PANEL_BORDER_COLOR, paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true, color: state.color }, state.title),
    h(Text, null, state.body),
    h(Text, { color: "gray" }, state.hint),
  );
}
