import { Box, Text, useStdout } from "ink";
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
  const { stdout } = useStdout();
  const minHeight = stdout?.rows || 24;
  const profile = dashboard.profile.profile;
  const planner = profile ? `${profile.planner_provider}/${profile.planner_model}` : "missing planner";
  const providerLabel = profile ? `${profile.available_models.length || "default"} model(s) active` : "run setup";
  const showSlashMenu = chatCommandInput.trimStart().startsWith("/");
  const promptText = chatCommandInput.length > 0 ? chatCommandInput : 'Ask anything... "Plan the next project slice"';

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1 },
    h(
      Box,
      { alignItems: "center", flexDirection: "column", paddingTop: 2, paddingBottom: 1 },
      h(OpenCodeLogo),
    ),
    h(
      Box,
      { alignItems: "center", flexDirection: "column", flexGrow: 1, justifyContent: "center" },
      h(
        Box,
        { width: 72, paddingX: 1, flexDirection: "column", borderStyle: "single", borderColor: "cyan" },
        h(
          Text,
          null,
          h(Text, { color: chatCommandInput.length > 0 ? "white" : "gray" }, promptText),
        ),
        h(
          Text,
          null,
          h(Text, { bold: true }, `${planner} `),
          h(Text, { color: "gray" }, `(Primary) ${providerLabel}`),
        ),
      ),
      h(
        Box,
        { width: 72, flexDirection: "column" },
        ...(showSlashMenu
          ? [
              h(
                Box,
                { key: "landing-slash", marginTop: 1, flexDirection: "column" },
                h(SlashCommandPanel, { chatCommandInput, landing: true, selectedIndex: slashCommandCursor }),
              ),
            ]
          : []),
        ...(isSelectingChatModel
          ? [
              h(
                Box,
                { key: "landing-model-selector", marginTop: 1, flexDirection: "column" },
                h(ChatModelSelectorPanel, { dashboard, cursor: chatModelCursor }),
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
      )
    ),
    h(
      Box,
      { flexDirection: "column" },
      h(ActionResultPanel, { result: actionResult }),
      h(
        Box,
        { paddingX: 1, paddingBottom: 1 },
        h(Text, null, h(Text, { color: "yellow" }, "* Tip "), h(Text, { color: "gray" }, "Use /providers, /models, /auth, or /registry before the first request.")),
      ),
      h(OpenCodePathBar, { dashboard }),
    )
  );
}
