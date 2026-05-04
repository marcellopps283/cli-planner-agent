import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportBlueprint, ExportManifestSchema } from "../src/export.js";
import { generateBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile } from "../src/profile.js";

describe("blueprint export", () => {
  it("exports a lintable handoff directory without local-only files by default", async () => {
    const root = await makePlannedProject();
    await mkdir(path.join(root, ".blueprint", "revisions"), { recursive: true });
    await mkdir(path.join(root, ".blueprint", "tui_sessions"), { recursive: true });
    await writeFile(path.join(root, ".blueprint", "revisions", "revision.json"), "{}\n", "utf8");
    await writeFile(path.join(root, ".blueprint", "tui_sessions", "session.json"), "{}\n", "utf8");

    const result = await exportBlueprint({
      root,
      out: path.join(root, "handoff-export"),
    });
    const manifest = ExportManifestSchema.parse(
      JSON.parse(await readFile(path.join(result.outputPath, "EXPORT_MANIFEST.json"), "utf8")),
    );

    expect(result.outputPath).toBe(path.join(root, "handoff-export"));
    expect(manifest.included_files).toContain("architecture.md");
    expect(manifest.included_files).toContain("dependencies_graph.json");
    expect(manifest.included_files).toContain("tasks/001-update-docs.md");
    expect(manifest.included_files).not.toContain("profile.yaml");
    expect(manifest.included_files).not.toContain("revisions/revision.json");
    expect(manifest.included_files).not.toContain("tui_sessions/session.json");
    expect(manifest.excluded_files).toContain("profile.yaml");
    expect(manifest.excluded_files).toContain("revisions/revision.json");
    expect(manifest.excluded_files).toContain("tui_sessions/**");
    await expect(readFile(path.join(result.outputPath, "tasks", "001-update-docs.md"), "utf8")).resolves.toContain(
      "<task_objective>",
    );
  });

  it("can include profile and revision records when explicitly requested", async () => {
    const root = await makePlannedProject();
    await mkdir(path.join(root, ".blueprint", "revisions"), { recursive: true });
    await writeFile(path.join(root, ".blueprint", "revisions", "revision.json"), "{}\n", "utf8");

    const result = await exportBlueprint({
      root,
      out: path.join(root, "full-export"),
      includeProfile: true,
      includeRevisions: true,
    });

    expect(result.manifest.included_files).toContain("profile.yaml");
    expect(result.manifest.included_files).toContain("revisions/revision.json");
    await expect(readFile(path.join(result.outputPath, "profile.yaml"), "utf8")).resolves.toContain("planner_provider");
  });

  it("refuses invalid blueprints unless allowInvalid is set", async () => {
    const root = await makePlannedProject();
    const taskPath = path.join(root, ".blueprint", "tasks", "001-update-docs.md");
    const task = await readFile(taskPath, "utf8");

    await writeFile(taskPath, task.replace("<acceptance_contract>", "<acceptance_contract_removed>"), "utf8");

    await expect(
      exportBlueprint({
        root,
        out: path.join(root, "invalid-export"),
      }),
    ).rejects.toThrow("Blueprint lint failed");

    const result = await exportBlueprint({
      root,
      out: path.join(root, "invalid-export"),
      allowInvalid: true,
    });

    expect(result.manifest.included_files).toContain("tasks/001-update-docs.md");
  });
});

async function makePlannedProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-export-test-"));
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
    overview: "Fixture plan for export.",
    assumptions: ["The project has a valid blueprint."],
    decisions: ["Keep docs and implementation separate."],
    risks: ["Exported handoffs must remain complete."],
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
