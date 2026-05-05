import { Box, Text } from "ink";
import React, { createElement } from "react";

import { OpenCodeLogo } from "./logo.js";
import { ChatModelSelectorPanel, FocusOverlay, SlashCommandPanel, ActionResultPanel, OpenCodePathBar } from "./panels.js";
import { type PlanChatStep, type TuiActionId, type TuiActionResult, type TuiDashboard } from "../tui.js";

const h = createElement;

export function LandingSurface({
  dashboard,
  chatCommandInput,
  actionResult,
  pendingConfirmation,
  isEditingRevise,
  reviseInput,
  isEditingModelPool,
  modelPoolInput,
  isSelectingChatModel,
  chatModelCursor = 0,
  slashCommandCursor = 0,
  planChatStep,
  planChatInput,
}: {
  dashboard: TuiDashboard;
  chatCommandInput: string;
  actionResult?: TuiActionResult;
  pendingConfirmation?: TuiActionId;
  isEditingRevise?: boolean;
  reviseInput?: string;
  isEditingModelPool?: boolean;
  modelPoolInput?: string;
  isSelectingChatModel?: boolean;
  chatModelCursor?: number;
  slashCommandCursor?: number;
  planChatStep?: PlanChatStep;
  planChatInput?: string;
}): React.ReactElement {
  const profile = dashboard.profile.profile;
  const planner = profile ? `${profile.planner_provider}/${profile.planner_model}` : "missing planner";
  const providerLabel = profile ? `${profile.available_models.length || "default"} model(s) active` : "run setup";
  const showSlashMenu = chatCommandInput.trimStart().startsWith("/");
  const promptText = chatCommandInput.length > 0 ? chatCommandInput : 'Ask anything... "Plan the next project slice"';

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(
      Box,
      { alignItems: "center", flexDirection: "column", paddingY: 1 },
      h(OpenCodeLogo),
      h(
        Box,
        { width: 72, paddingX: 1, flexDirection: "column" },
        h(
          Text,
          null,
          h(Text, { color: "cyan" }, "| "),
          h(Text, { color: chatCommandInput.length > 0 ? "white" : "gray" }, promptText),
        ),
        h(
          Text,
          null,
          h(Text, { color: "cyan" }, "Plan "),
          h(Text, { bold: true }, `${planner} `),
          h(Text, { color: "gray" }, `(Primary) ${providerLabel}`),
        ),
      ),
      h(Text, { color: "gray" }, "tab models    ctrl+p commands"),
    ),
    h(
      Box,
      { paddingX: 1 },
      h(Text, null, h(Text, { color: "yellow" }, "* Tip "), h(Text, { color: "gray" }, "Use /providers, /models, /auth, or /registry before the first request.")),
    ),
    ...(showSlashMenu
      ? [
          h(
            Box,
            { key: "landing-slash", alignItems: "center", flexDirection: "column" },
            h(Box, { width: 72 }, h(SlashCommandPanel, { chatCommandInput, landing: true, selectedIndex: slashCommandCursor })),
          ),
        ]
      : []),
    ...(isSelectingChatModel
      ? [
          h(
            Box,
            { key: "landing-model-selector", alignItems: "center", flexDirection: "column" },
            h(Box, { width: 72 }, h(ChatModelSelectorPanel, { dashboard, cursor: chatModelCursor })),
          ),
        ]
      : []),
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
    h(OpenCodePathBar, { dashboard }),
  );
}
