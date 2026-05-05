import { Box, Text } from "ink";
import React, { createElement } from "react";

import {
  TUI_APP_NAME,
  TUI_APP_VERSION,
  TUI_SLASH_COMMANDS,
  type TuiActionId,
  type TuiActionResult,
  type TuiDashboard,
  type PlanChatStep,
  chatModelsForConnectedProvider,
  currentFocusOverlay,
  getSlashCommandSuggestions,
} from "../tui.js";

const h = createElement;

export function ActionResultPanel({ result }: { result?: TuiActionResult }): React.ReactElement | null {
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

export function OpenCodePathBar({ dashboard }: { dashboard: TuiDashboard }): React.ReactElement {
  return h(
    Box,
    { justifyContent: "space-between" },
    h(Text, { color: "gray" }, dashboard.root),
    h(Text, { color: "gray" }, `${TUI_APP_NAME} ${TUI_APP_VERSION}`),
  );
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
}: {
  dashboard: TuiDashboard;
  cursor: number;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const models = chatModelsForConnectedProvider(dashboard);
  const selectedIndex = Math.min(cursor, Math.max(models.length - 1, 0));
  const provider = profile?.planner_provider ?? "missing";

  if (!profile) {
    return h(
      Box,
      { borderStyle: "single", borderColor: "yellow", paddingX: 1, flexDirection: "column" },
      h(Text, { bold: true }, "Model Selector"),
      h(Text, null, "Profile is missing. Run setup before selecting a chat model."),
    );
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, "Model Selector"),
    h(Text, { color: "gray" }, `Connected CLI: ${provider}. Enter selects, Esc closes.`),
    ...(models.length > 0
      ? models.map((model, index) =>
          h(
            Text,
            {
              key: model.id,
              color: index === selectedIndex ? "cyan" : model.id === profile.planner_model ? "green" : undefined,
              bold: index === selectedIndex,
            },
            `${index === selectedIndex ? ">" : " "} ${model.id} ${model.id === profile.planner_model ? "(current)" : ""} ${model.tier}/${model.status}`,
          ),
        )
      : [h(Text, { key: "empty", color: "yellow" }, `No models found for ${provider}. Refresh the registry or update the provider pool.`)]),
  );
}

export function SlashCommandPanel({
  chatCommandInput,
  landing = false,
  selectedIndex = 0,
}: {
  chatCommandInput: string;
  landing?: boolean;
  selectedIndex?: number;
}): React.ReactElement {
  const suggestions = getSlashCommandSuggestions(chatCommandInput);
  const isFiltering = chatCommandInput.trim().startsWith("/");

  if (!isFiltering) {
    return h(
      Box,
      { borderStyle: "single", borderColor: "gray", paddingX: 1 },
      h(
        Text,
        { color: "gray" },
        landing
          ? "Type / to configure providers, models, auth, registry, or help."
          : "Type / for commands, /menu for navigation, /help for the full command list.",
      ),
    );
  }

  const commandsToRender = suggestions.length > 0 ? suggestions : TUI_SLASH_COMMANDS;
  const activeIndex = Math.min(selectedIndex, Math.max(commandsToRender.length - 1, 0));

  return h(
    Box,
    { borderStyle: "single", borderColor: "gray", paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, isFiltering ? "Slash Autocomplete" : "Slash Commands"),
    ...(isFiltering ? [h(Text, { key: "tab-hint", color: "gray" }, "Use \u2191\u2193 to choose. Tab completes. Enter runs selected command.")] : []),
    ...commandsToRender.map((command, index) =>
      h(
        Text,
        { key: command.command, color: isFiltering && index === activeIndex ? "cyan" : undefined },
        `${index === activeIndex && isFiltering ? "> " : "  "}${command.usage} | ${command.description}`,
      ),
    ),
  );
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
    { borderStyle: "round", borderColor: state.color, paddingX: 1, flexDirection: "column" },
    h(Text, { bold: true }, state.title),
    h(Text, null, state.body),
    h(Text, { color: "gray" }, state.hint),
  );
}
