import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { exportBlueprint } from "../src/export.js";
import { generateBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile, loadPlannerProfile } from "../src/profile.js";
import {
  BlueprintDashboard,
  getSlashCommandSuggestions,
  getTuiActions,
  loadTuiDashboard,
  parseTuiSlashCommandInput,
  parseTuiView,
  renderTuiDashboardToString,
  runTuiAction,
  shouldDisplayTuiActionResult,
  TuiSessionRecordSchema,
} from "../src/tui.js";

describe("blueprint tui", () => {
  it("renders onboarding when the current directory has no blueprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-empty-test-"));
    const dashboard = await loadTuiDashboard({ root });
    const output = renderTuiDashboardToString(dashboard, "providers");
    const actionsOutput = renderTuiDashboardToString(dashboard, "actions");
    const actions = getTuiActions(dashboard);

    expect(dashboard.setup.initialized).toBe(false);
    expect(dashboard.nextAction).toContain("Start onboarding");
    expect(actions[0]?.id).toBe("setup");
    expect(output).toContain("Blueprint not initialized");
    expect(output).toContain("Press c to choose another directory");
    expect(actionsOutput).toContain("Start Here");
    expect(actionsOutput).toContain("Provider CLIs");
    expect(actionsOutput).toContain("1 or Enter: configure harness in this directory");
    expect(actionsOutput).toContain("2: create a new project folder here");
    expect(output).not.toContain("Profile error");
  });

  it("runs guided setup from an empty project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-setup-test-"));
    const result = await runTuiAction({
      root,
      actionId: "setup",
      providerChecker: async () => [
        {
          id: "openai",
          cli: "codex",
          installed: true,
          authCheck: "not_checked",
          detail: "installed",
        },
        {
          id: "google",
          cli: "gemini",
          installed: true,
          authCheck: "not_checked",
          detail: "installed",
        },
        {
          id: "anthropic",
          cli: "claude",
          installed: false,
          authCheck: "failed",
          detail: "missing",
        },
      ],
    });
    const manifest = await readFile(path.join(root, ".blueprint", "blueprint.yaml"), "utf8");
    const profile = await readFile(path.join(root, ".blueprint", "profile.yaml"), "utf8");
    const registry = await readFile(path.join(root, ".blueprint", "model_registry.yaml"), "utf8");
    const dashboard = await loadTuiDashboard({ root });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Blueprint setup completed");
    expect(manifest).toContain("planner_provider: google");
    expect(profile).toContain("planner_provider: google");
    expect(profile).toContain("- openai");
    expect(profile).toContain("- google");
    expect(registry).toContain("gemini-3.1-pro-preview");
    expect(dashboard.setup.initialized).toBe(true);
    expect(dashboard.profile.errors).toEqual([]);
  });

  it("renders setup as provider, model, then reasoning-effort flow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-setup-flow-test-"));
    const dashboard = await loadTuiDashboard({ root });
    const setupDraft = {
      providers: ["openai" as const, "google" as const],
      models: ["gpt-5.5", "gemini-3.1-pro-preview"],
      reasoningEfforts: {
        "gpt-5.5": "xhigh",
        "gemini-3.1-pro-preview": "high",
      },
      plannerModel: "gpt-5.5",
    };
    const providersOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        setupStep: "providers",
        setupDraft,
      }),
    );
    const modelsOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        setupStep: "models",
        setupDraft,
        setupModelProviderCursor: 1,
      }),
    );
    const reasoningOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        setupStep: "reasoning",
        setupDraft,
        setupReasoningModelCursor: 0,
        setupReasoningEffortCursor: 4,
      }),
    );

    expect(providersOutput).toContain("OPENAI");
    expect(providersOutput).toContain("GOOGLE");
    expect(providersOutput).not.toContain("gpt-5.5");
    expect(modelsOutput).toContain("GOOGLE");
    expect(modelsOutput).toContain("gemini-3.1-pro-preview");
    expect(reasoningOutput).toContain("Reasoning Effort");
    expect(reasoningOutput).toContain("gpt-5.5");
    expect(reasoningOutput).toContain("> [x] xhigh");
  });

  it("runs setup with explicit provider, model, and planner selections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-selective-setup-test-"));
    const result = await runTuiAction({
      root,
      actionId: "setup",
      providers: ["openai", "google"],
      models: ["gpt-5.5", "gemini-3.1-flash-lite-preview"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
      providerChecker: async () => [
        {
          id: "openai",
          cli: "codex",
          installed: true,
          authCheck: "not_checked",
          detail: "installed",
        },
        {
          id: "google",
          cli: "gemini",
          installed: true,
          authCheck: "not_checked",
          detail: "installed",
        },
        {
          id: "anthropic",
          cli: "claude",
          installed: false,
          authCheck: "failed",
          detail: "missing",
        },
      ],
    });
    const profileResult = await loadPlannerProfile(root);

    expect(result.status).toBe("ok");
    expect(result.lines).toContain("providers openai,google");
    expect(result.lines).toContain("models gpt-5.5,gemini-3.1-flash-lite-preview");
    expect(result.lines).toContain("planner openai/gpt-5.5");
    expect(profileResult.errors).toEqual([]);
    expect(profileResult.profile?.available_providers).toEqual(["openai", "google"]);
    expect(profileResult.profile?.available_models).toEqual(["gpt-5.5", "gemini-3.1-flash-lite-preview"]);
    expect(profileResult.profile?.planner_model).toBe("gpt-5.5");
  });

  it("loads a dashboard model from a generated blueprint", async () => {
    const root = await makePlannedProject();
    await exportBlueprint({
      root,
      out: path.join(root, ".blueprint", "exports", "fixture-export"),
    });

    const dashboard = await loadTuiDashboard({ root });

    expect(dashboard.setup.initialized).toBe(true);
    expect(dashboard.profile.profile?.planner_provider).toBe("google");
    expect(dashboard.lint.errors).toEqual([]);
    expect(dashboard.tasks).toHaveLength(2);
    expect(dashboard.graph?.edges).toHaveLength(1);
    expect(dashboard.exports).toEqual(["exports/fixture-export"]);
    expect(dashboard.nextAction).toContain("blueprint export");
  });

  it("renders the dashboard with Ink primitives", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const output = renderTuiDashboardToString(dashboard);
    const mainOutput = renderTuiDashboardToString(dashboard, "main");
    const overviewOutput = renderTuiDashboardToString(dashboard, "overview");

    expect(output).toContain("blueprint");
    expect(output).not.toContain("Background Task Completed");
    expect(mainOutput).toContain("Operations");
    expect(mainOutput).toContain("status handoffs ready");
    expect(mainOutput).toContain("provider_pool openai,google");
    expect(mainOutput).toContain("Main Menu");
    expect(mainOutput).toContain("Plan / Actions");
    expect(mainOutput).toContain("Overview");
    expect(mainOutput).toContain("Providers / Models");
    expect(overviewOutput).toContain("\u2705 Profile");
    expect(overviewOutput).toContain("Artifacts");
    expect(overviewOutput).toContain(".blueprint/tasks");
    expect(overviewOutput).toContain("Next");
  });

  it("renders task, graph, providers, and actions views", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const tasksOutput = renderTuiDashboardToString(dashboard, "tasks");
    const graphOutput = renderTuiDashboardToString(dashboard, "graph");
    const providersOutput = renderTuiDashboardToString(dashboard, "providers");
    const actionsOutput = renderTuiDashboardToString(dashboard, "actions");

    expect(tasksOutput).toContain("Task Details");
    expect(tasksOutput).toContain("Execution Graph");
    expect(tasksOutput).toContain("task-001-update-docs");
    expect(graphOutput).toContain("Graph Edges");
    expect(graphOutput).toContain("task-001-update-docs \u2192 task-002-implement-api");
    expect(providersOutput).toContain("Provider Pool");
    expect(providersOutput).toContain("available openai,google");
    expect(providersOutput).toContain("Model Catalog");
    expect(actionsOutput).toContain("Ask anything...");
    expect(actionsOutput).not.toContain("Background Task Completed");
    expect(actionsOutput).toContain("type / for commands");
    expect(actionsOutput).toContain("tab switch model");
    expect(actionsOutput).not.toContain("Quick action");
  });

  it("renders an OpenCode-like landing screen before the first planning request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-landing-test-"));
    await writeFile(path.join(root, "README.md"), "# Landing\n", "utf8");
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    const dashboard = await loadTuiDashboard({ root });
    const output = renderTuiDashboardToString(dashboard);
    const typedOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        chatCommandInput: "planejar tela inicial",
      }),
    );
    const slashOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        chatCommandInput: "/",
      }),
    );
    const scrolledSlashOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        chatCommandInput: "/",
        slashCommandCursor: 9,
        slashCommandScrollOffset: 6,
      }),
    );

    expect(output).toContain("Ask anything");
    expect(output).toContain("openai/gpt-5.5");
    expect(output).toContain("ctrl+p commands");
    expect(output).not.toContain("Slash Autocomplete");
    expect(typedOutput).toContain("planejar tela inicial");
    expect(typedOutput).not.toContain("Slash Autocomplete");
    expect(slashOutput).toContain("Slash Autocomplete");
    expect(slashOutput).toContain("/plan [brief]");
    expect(slashOutput).toContain("/providers");
    expect(slashOutput).toContain("/model [id]");
    expect(slashOutput).not.toContain("/auth-live");
    expect(scrolledSlashOutput).not.toContain("/plan [brief]");
    expect(scrolledSlashOutput).toContain("> /auth-live");
    expect(output).not.toContain("Main Menu");
    expect(output).not.toContain("Quick action");
  });

  it("parses local TUI slash commands", () => {
    expect(parseTuiSlashCommandInput("plan a feature")).toBeUndefined();
    expect(parseTuiSlashCommandInput("/plan build planner chat")).toEqual({
      command: "/plan",
      argument: "build planner chat",
    });
    expect(parseTuiSlashCommandInput("/models all")).toEqual({
      command: "/models",
      argument: "all",
    });
    expect(parseTuiSlashCommandInput("/model gemini-3.1-pro-preview")).toEqual({
      command: "/model",
      argument: "gemini-3.1-pro-preview",
    });
    expect(parseTuiSlashCommandInput("/registry")).toEqual({
      command: "/registry",
      argument: "",
    });
    expect(parseTuiSlashCommandInput("/unknown anything")).toEqual({
      command: "/help",
      argument: "unknown /unknown",
    });
    expect(getSlashCommandSuggestions("/mo").map((command) => command.command)).toEqual(["/model", "/models"]);
  });

  it("runs the landing request through the active planner model and renders agent-owned state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-agent-workflow-test-"));
    await writeFile(path.join(root, "README.md"), "# Agent workflow\n", "utf8");
    await runTuiAction({
      root,
      actionId: "setup",
      providerChecker: async () => [
        {
          id: "openai",
          cli: "codex",
          installed: false,
          authCheck: "failed",
          detail: "missing",
        },
        {
          id: "google",
          cli: "gemini",
          installed: true,
          authCheck: "not_checked",
          detail: "installed",
        },
        {
          id: "anthropic",
          cli: "claude",
          installed: false,
          authCheck: "failed",
          detail: "missing",
        },
      ],
      recordHistory: false,
    });

    const result = await runTuiAction({
      root,
      actionId: "agent-workflow",
      agentRequest: "planeje um harness agentico com checkboxes validados pela IA",
      plannerPromptRunner: async (options) => ({
        provider: options.provider,
        model: options.model,
        response: JSON.stringify({
          schema_version: "1.0",
          user_request: "planeje um harness agentico com checkboxes validados pela IA",
          planner: {
            provider: options.provider,
            model: options.model,
            reasoning_effort: options.reasoningEffort,
          },
          project_state: {
            title: "Harness agentico",
            summary: "O planner deve conduzir o workflow e validar o estado que a TUI renderiza.",
            current_phase: "Understanding project",
            health: "needs_input",
            confidence: 0.72,
          },
          messages: [
            {
              role: "planner",
              content: "Entendi que o app renderiza o workflow, mas o modelo decide o estado semantico.",
            },
          ],
          checklist: [
            {
              id: "understand_request",
              label: "Entender pedido inicial",
              status: "done",
              validated_by: "active planner model",
              evidence: "pedido inicial recebido",
              interactive: true,
            },
            {
              id: "validate_scope",
              label: "Validar escopo do harness",
              status: "in_progress",
              interactive: true,
            },
          ],
          questions: [
            {
              id: "q1",
              question: "O planner pode gerar preview assim que a checklist estiver pronta?",
              required: true,
            },
          ],
          next_action: {
            type: "ask_user",
            label: "Responder pergunta de escopo",
            prompt: "Responda a pergunta pendente do planner.",
          },
        }),
        rawOutput: "",
      }),
      recordHistory: false,
    });
    const dashboard = await loadTuiDashboard({ root });
    const firstScreenOutput = renderTuiDashboardToString(dashboard, "actions");
    const output = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        hasStartedChatWorkflow: true,
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Understanding project");
    expect(result.lines).toContain("check done understand_request Entender pedido inicial");
    expect(dashboard.agentState?.checklist[0]?.status).toBe("done");
    expect(firstScreenOutput).toContain("Ask anything");
    expect(firstScreenOutput).not.toContain("Planner Agent State");
    expect(output).toContain("Planner Agent State");
    expect(output).toContain("[x] Entender pedido inicial");
    expect(output).toContain("[~] Validar escopo do harness");
    expect(output).toContain("O planner pode gerar preview");
    expect(output).not.toContain("Planning Intake");
  });

  it("does not render a persistent success panel for chat model switches", () => {
    expect(
      shouldDisplayTuiActionResult({
        actionId: "planner-model",
        status: "ok",
        summary: "Chat model switched.",
        lines: [],
      }),
    ).toBe(false);
    expect(
      shouldDisplayTuiActionResult({
        actionId: "planner-model",
        status: "failed",
        summary: "Missing planner model.",
        lines: [],
      }),
    ).toBe(true);
  });

  it("renders slash autocomplete and focused overlays", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const richBrief =
      "Objetivo: refazer o layout da TUI. Escopo: chat fullscreen inspirado no OpenCode. Requisitos: status line, slash commands, artifact checklist, providers configuraveis, paths claros e validacao com testes. Stack TypeScript.";
    const autocompleteOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        chatCommandInput: "/mo",
      }),
    );
    const selectedAutocompleteOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        chatCommandInput: "/mo",
        slashCommandCursor: 1,
      }),
    );
    const overlayOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        isEditingModelPool: true,
        modelPoolInput: "all",
      }),
    );
    const adaptiveOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        planChatStep: "successCriteria",
        planChatDraft: { brief: richBrief },
      }),
    );

    expect(autocompleteOutput).toContain("Slash Autocomplete");
    expect(autocompleteOutput).toContain("> /model [id]");
    expect(autocompleteOutput).toContain("Use \u2191\u2193 to choose");
    expect(selectedAutocompleteOutput).toContain("> /models <ids|all>");
    expect(overlayOutput).toContain("Model Pool Overlay");
    expect(overlayOutput).toContain("Enter saves the model pool");
    expect(adaptiveOutput).toContain("Planning Intake");
    expect(adaptiveOutput).toContain("[ ] Criterios de sucesso");
    expect(adaptiveOutput).not.toContain("Resumo do projeto em uma frase");
  });

  it("builds executable TUI actions with quota confirmation metadata", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const actions = getTuiActions(dashboard);

    expect(actions.map((action) => action.id)).toEqual([
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
    ]);
    expect(actions.find((action) => action.id === "agent-workflow")?.requiresInput).toBe(true);
    expect(actions.find((action) => action.id === "model-pool")?.requiresInput).toBe(true);
    expect(actions.find((action) => action.id === "planner-model")?.requiresInput).toBe(true);
    expect(actions.find((action) => action.id === "plan")?.requiresInput).toBe(true);
    expect(actions.find((action) => action.id === "registry-refresh")?.requiresConfirmation).toBe(true);
    expect(actions.find((action) => action.id === "export")?.enabled).toBe(true);
    expect(actions.find((action) => action.id === "revise")?.requiresInput).toBe(true);
    expect(actions.find((action) => action.id === "auth-doctor-live")?.requiresConfirmation).toBe(true);
  });

  it("runs lint and export actions", async () => {
    const root = await makePlannedProject();
    const lint = await runTuiAction({ root, actionId: "lint" });
    const exported = await runTuiAction({ root, actionId: "export" });

    expect(lint.status).toBe("ok");
    expect(lint.summary).toContain("Blueprint lint passed");
    expect(exported.status).toBe("ok");
    expect(exported.summary).toContain("Exported");
    expect(exported.lines.some((line) => line.startsWith("output "))).toBe(true);
  });

  it("previews and applies planning through a TUI action", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-plan-action-test-"));
    await writeFile(path.join(root, "README.md"), "# Plan action\n", "utf8");
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });

    const preview = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      recordHistory: false,
    });
    let dashboard = await loadTuiDashboard({ root });

    expect(preview.status).toBe("ok");
    expect(preview.canApply).toBe(true);
    expect(preview.summary).toContain("Plan preview ready");
    expect(preview.lines.some((line) => line.includes("task-002-implement-core-work model gpt-5.5"))).toBe(true);
    expect(dashboard.tasks).toEqual([]);

    const applied = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      apply: true,
      recordHistory: false,
    });
    dashboard = await loadTuiDashboard({ root });

    expect(applied.status).toBe("ok");
    expect(applied.summary).toContain("Generated");
    expect(applied.lines).toContain("artifact_root .blueprint");
    expect(applied.lines).toContain("tasks_dir .blueprint/tasks");
    expect(applied.lines).toContain("integration .blueprint/integration_guide.md");
    expect(applied.lines).toContain("file .blueprint/dependencies_graph.json");
    expect(dashboard.tasks).toHaveLength(3);
    expect(dashboard.lint.errors).toEqual([]);
  });

  it("offers an LLM planner fallback inside the TUI action flow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-plan-fallback-test-"));
    await writeFile(path.join(root, "README.md"), "# Plan fallback\n", "utf8");
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
    });

    const failed = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      planEngine: "llm",
      plannerPromptRunner: async () => {
        throw new Error("quota unavailable");
      },
      recordHistory: false,
    });

    expect(failed.status).toBe("failed");
    expect(failed.canApply).toBe(true);
    expect(failed.summary).toContain("Fallback available: google/gemini-3.1-pro-preview");
    expect(failed.lines).toContain("failed_model gpt-5.5");
    expect(failed.planContinuation).toMatchObject({
      type: "fallback",
      engine: "llm",
      plannerProvider: "google",
      plannerModel: "gemini-3.1-pro-preview",
      attemptedModels: ["gpt-5.5"],
    });

    const fallbackPreview = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      planEngine: "llm",
      plannerProvider: failed.planContinuation?.plannerProvider,
      plannerModel: failed.planContinuation?.plannerModel,
      planAttemptedModels: failed.planContinuation?.attemptedModels,
      plannerPromptRunner: async (options) => ({
        provider: options.provider,
        model: options.model,
        response: JSON.stringify(makeDraft()),
        rawOutput: "",
      }),
      recordHistory: false,
    });

    expect(fallbackPreview.status).toBe("ok");
    expect(fallbackPreview.lines).toContain("planner google/gemini-3.1-pro-preview fallback");
    expect(fallbackPreview.planContinuation).toMatchObject({
      type: "apply",
      engine: "llm",
      plannerProvider: "google",
      plannerModel: "gemini-3.1-pro-preview",
      attemptedModels: ["gpt-5.5", "gemini-3.1-pro-preview"],
    });
  });

  it("offers deterministic preview when no LLM fallback model remains", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-deterministic-fallback-test-"));
    await writeFile(path.join(root, "README.md"), "# Deterministic fallback\n", "utf8");
    await initPlannerProfile({
      root,
      providers: ["openai"],
      models: ["gpt-5.5"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
    });

    const failed = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      planEngine: "llm",
      plannerPromptRunner: async () => {
        throw new Error("quota unavailable");
      },
      recordHistory: false,
    });

    expect(failed.status).toBe("failed");
    expect(failed.summary).toContain("Deterministic fallback available");
    expect(failed.planContinuation).toMatchObject({
      type: "fallback",
      engine: "deterministic",
      attemptedModels: ["gpt-5.5"],
    });

    const deterministicPreview = await runTuiAction({
      root,
      actionId: "plan",
      planAnswers: makeAnswers(),
      planEngine: "deterministic",
      recordHistory: false,
    });

    expect(deterministicPreview.status).toBe("ok");
    expect(deterministicPreview.lines).toContain("engine deterministic");
  });

  it("updates the active model pool through a TUI action", async () => {
    const root = await makePlannedProject();
    const result = await runTuiAction({
      root,
      actionId: "model-pool",
      modelPool: "gpt-5.5,gemini-3.1-pro-preview",
    });
    const profile = await loadPlannerProfile(root);
    const dashboard = await loadTuiDashboard({ root });
    const providersOutput = renderTuiDashboardToString(dashboard, "providers");

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Model pool updated with 2 model");
    expect(profile.errors).toEqual([]);
    expect(profile.profile?.available_models).toEqual(["gpt-5.5", "gemini-3.1-pro-preview"]);
    expect(providersOutput).toContain("Model Pool");
    expect(providersOutput).toContain("gpt-5.5");
  });

  it("switches the chat planner model through the model selector action", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const selectorOutput = renderToString(
      createElement(BlueprintDashboard, {
        dashboard,
        view: "actions",
        isSelectingChatModel: true,
        chatModelCursor: 1,
      }),
    );
    const result = await runTuiAction({
      root,
      actionId: "planner-model",
      plannerModel: "gemini-3.1-pro-preview-customtools",
    });
    const profile = await loadPlannerProfile(root);

    expect(selectorOutput).toContain("Model Selector");
    expect(selectorOutput).toContain("Connected CLI: google");
    expect(selectorOutput).toContain("gemini-3.1-pro-preview");
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Chat model switched");
    expect(profile.profile?.planner_provider).toBe("google");
    expect(profile.profile?.planner_model).toBe("gemini-3.1-pro-preview-customtools");
    expect(profile.profile?.available_models).toContain("gemini-3.1-pro-preview-customtools");
  });

  it("refreshes the model registry through a TUI action", async () => {
    const root = await makePlannedProject();
    const result = await runTuiAction({
      root,
      actionId: "registry-refresh",
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("model registry");
    expect(result.lines.some((line) => line.startsWith("updated "))).toBe(true);
  });

  it("records TUI action history outside revisions", async () => {
    const root = await makePlannedProject();
    const result = await runTuiAction({ root, actionId: "lint" });
    const record = TuiSessionRecordSchema.parse(JSON.parse(await readFile(result.sessionPath!, "utf8")));
    const dashboard = await loadTuiDashboard({ root });

    expect(result.sessionPath).toContain(path.join(".blueprint", "tui_sessions"));
    expect(record.action.id).toBe("lint");
    expect(record.result.status).toBe("ok");
    expect(record.result.summary).toContain("Blueprint lint passed");
    expect(dashboard.tuiSessions).toHaveLength(1);
    expect(dashboard.tuiSessions[0]).toContain("tui_sessions/");
  });

  it("previews and applies revise actions with confirmation-ready metadata", async () => {
    const root = await makePlannedProject();
    const preview = await runTuiAction({
      root,
      actionId: "revise",
      change: "Adicione criterio de lint na task 002.",
    });
    const applied = await runTuiAction({
      root,
      actionId: "revise",
      change: "Faça task-002-implement-api depender da task-001-update-docs.",
      apply: true,
    });

    expect(preview.status).toBe("ok");
    expect(preview.summary).toContain("task_local");
    expect(preview.canApply).toBe(true);
    expect(preview.change).toBe("Adicione criterio de lint na task 002.");
    expect(preview.lines).toContain("apply available after confirmation");
    expect(applied.status).toBe("ok");
    expect(applied.summary).toContain("applied");
    expect(applied.lines).toContain("application applied");
  });

  it("runs auth doctor actions through an injectable provider checker", async () => {
    const root = await makePlannedProject();
    const auth = await runTuiAction({
      root,
      actionId: "auth-doctor",
      providerChecker: async (live) => [
        {
          id: "google",
          cli: "gemini",
          installed: true,
          authCheck: live ? "failed" : "not_checked",
          detail: live ? "quota unavailable" : "installed",
        },
      ],
    });

    expect(auth.status).toBe("ok");
    expect(auth.summary).toContain("Checked 1 provider");
    expect(auth.lines).toContain("google installed not_checked installed");
  });

  it("parses known TUI views and rejects unknown ones", () => {
    expect(parseTuiView("main")).toBe("main");
    expect(parseTuiView("graph")).toBe("graph");
    expect(() => parseTuiView("unknown")).toThrow("Unknown TUI view");
  });

  it("points to lint when artifacts are invalid", async () => {
    const root = await makePlannedProject();
    const taskPath = path.join(root, ".blueprint", "tasks", "001-update-docs.md");
    const task = await readFile(taskPath, "utf8");

    await writeFile(taskPath, task.replace("<execution_prompt>", "<execution_prompt_removed>"), "utf8");

    const dashboard = await loadTuiDashboard({ root });

    expect(dashboard.lint.errors.length).toBeGreaterThan(0);
    expect(dashboard.nextAction).toContain("blueprint lint");
  });
});

async function makePlannedProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-tui-test-"));
  await writeFile(path.join(root, "README.md"), "# Test project\n", "utf8");
  await initPlannerProfile({
    root,
    providers: ["openai", "google"],
    plannerProvider: "google",
  });
  await generateBlueprintPlan({
    root,
    answers: makeAnswers(),
    draft: makeDraft(),
  });

  return root;
}

function makeAnswers(): PlanAnswers {
  return {
    projectSummary: "A TypeScript API with a planning blueprint.",
    objective: "Add a feature to a service.",
    successCriteria: ["The API behavior is implemented.", "The blueprint passes lint."],
    constraints: ["Keep the plan provider-aware."],
    outOfScope: ["Running workers automatically."],
    targetPaths: ["src/api.ts", "tests/api.test.ts", "docs/SPECS/commands.md"],
    validationCommands: ["corepack pnpm test"],
    riskLevel: 5,
    notes: [],
  };
}

function makeDraft(): PlannerDraft {
  return {
    schema_version: "1.0",
    overview: "Fixture plan for tui.",
    assumptions: ["The project has a valid blueprint."],
    decisions: ["Keep docs and implementation separate."],
    risks: ["TUI must reflect lint status."],
    integration_notes: ["Run blueprint lint before exporting."],
    tasks: [
      {
        id: "task-001-update-docs",
        title: "Update docs",
        objective: "Update command documentation.",
        suggested_model: "gemini-3.1-pro-preview",
        model_rationale: "Best long-context model in the active fixture pool.",
        acceptable_alternatives: ["gpt-5.5"],
        fit: "long_context",
        dependencies: [],
        allowed_paths: ["docs/SPECS/commands.md"],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: [],
        context_rules: ["Documentation-only task."],
        execution_prompt: "Update docs for the planned feature.",
        acceptance_contract: ["Docs are updated."],
      },
      {
        id: "task-002-implement-api",
        title: "Implement API",
        objective: "Implement API logic.",
        suggested_model: "gpt-5.5",
        model_rationale: "Best coding-heavy model in the active fixture pool.",
        acceptable_alternatives: ["gemini-3.1-pro-preview"],
        fit: "coding_heavy",
        dependencies: ["task-001-update-docs"],
        allowed_paths: ["src/api.ts"],
        forbidden_paths: [".env"],
        risk_level: 5,
        test_commands: ["corepack pnpm test"],
        context_rules: ["Stay in src/api.ts."],
        execution_prompt: "Implement the API logic.",
        acceptance_contract: ["API behavior works."],
      },
    ],
  };
}
