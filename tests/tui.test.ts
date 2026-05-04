import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportBlueprint } from "../src/export.js";
import { generateBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile, loadPlannerProfile } from "../src/profile.js";
import {
  getTuiActions,
  loadTuiDashboard,
  parseTuiView,
  renderTuiDashboardToString,
  runTuiAction,
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
    const overviewOutput = renderTuiDashboardToString(dashboard, "overview");

    expect(output).toContain("Blueprint Agent Harness");
    expect(output).toContain("Operations");
    expect(output).toContain("status handoffs ready");
    expect(output).toContain("provider_pool openai,google");
    expect(output).toContain("Main Menu");
    expect(output).toContain("Plan / Actions");
    expect(output).toContain("Overview");
    expect(output).toContain("Providers / Models");
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
    expect(actionsOutput).toContain("Action Queue");
    expect(actionsOutput).toContain("Configure Model Pool");
    expect(actionsOutput).toContain("Refresh Registry");
    expect(actionsOutput).toContain("Export Handoffs");
    expect(actionsOutput).toContain("blueprint auth doctor --live");
  });

  it("builds executable TUI actions with quota confirmation metadata", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const actions = getTuiActions(dashboard);

    expect(actions.map((action) => action.id)).toEqual([
      "plan",
      "model-pool",
      "registry-refresh",
      "lint",
      "export",
      "revise",
      "auth-doctor",
      "auth-doctor-live",
    ]);
    expect(actions.find((action) => action.id === "model-pool")?.requiresInput).toBe(true);
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
