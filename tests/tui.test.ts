import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportBlueprint } from "../src/export.js";
import { generateBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile } from "../src/profile.js";
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
    expect(dashboard.nextAction).toContain("blueprint init");
    expect(actions[0]?.id).toBe("setup");
    expect(output).toContain("Blueprint not initialized");
    expect(output).toContain("Press c to choose another directory");
    expect(actionsOutput).toContain("Setup Project");
    expect(output).toContain("blueprint profile init --providers openai,google");
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
    expect(registry).toContain("gemini-cli-default");
    expect(dashboard.setup.initialized).toBe(true);
    expect(dashboard.profile.errors).toEqual([]);
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

    expect(output).toContain("Blueprint TUI");
    expect(output).toContain("\u2705 Profile");
    expect(output).toContain("overview");
    expect(output).toContain("Next");
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
    expect(actionsOutput).toContain("Action Queue");
    expect(actionsOutput).toContain("Export Handoffs");
    expect(actionsOutput).toContain("blueprint auth doctor --live");
  });

  it("builds executable TUI actions with quota confirmation metadata", async () => {
    const root = await makePlannedProject();
    const dashboard = await loadTuiDashboard({ root });
    const actions = getTuiActions(dashboard);

    expect(actions.map((action) => action.id)).toEqual(["lint", "export", "revise", "auth-doctor", "auth-doctor-live"]);
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
        suggested_model: "gemini-cli-default",
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
        suggested_model: "openai-codex-default",
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
