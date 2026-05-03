import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import { lintBlueprint } from "../src/lint.js";
import { generateBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile } from "../src/profile.js";
import {
  buildTaskRewritePrompt,
  buildLocalDocRewritePrompt,
  parseRevisedDocument,
  readChangeInput,
  reviseBlueprint,
} from "../src/revise.js";

describe("blueprint revise", () => {
  it("classifies explicit task changes as task_local", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Adicione teste de contrato na task 002 sem mudar outras tasks.",
      dryRun: true,
    });

    expect(result.plan.classification).toBe("task_local");
    expect(result.plan.affected_tasks).toContain("task-002-implement-api");
    expect(result.writtenPath).toBeUndefined();
  });

  it("keeps weak temporal wording on a single explicit task as task_local", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Adicione uma frase no acceptance_contract da task 002 dizendo que blueprint lint deve passar depois da tarefa.",
      dryRun: true,
    });

    expect(result.plan.classification).toBe("task_local");
    expect(result.plan.affected_tasks).toEqual(["task-002-implement-api"]);
  });

  it("classifies dependency changes as graph_local", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Faça task-003-validate depender também da task-001-update-docs.",
      dryRun: true,
    });

    expect(result.plan.classification).toBe("graph_local");
    expect(result.plan.affected_tasks).toContain("task-003-validate");
    expect(result.plan.affected_tasks).toContain("task-001-update-docs");
  });

  it("applies explicit graph_local dependency additions deterministically", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Faça task-003-validate depender também da task-001-update-docs.",
      apply: true,
    });
    const graph = JSON.parse(await readFile(path.join(root, ".blueprint", "dependencies_graph.json"), "utf8")) as {
      nodes: Array<{ id: string; task_file: string; depends_on: string[] }>;
      edges: Array<{ from: string; to: string }>;
    };
    const targetNode = graph.nodes.find((node) => node.id === "task-003-validate")!;
    const targetTask = matter(await readFile(path.join(root, ".blueprint", targetNode.task_file), "utf8"));
    const lint = await lintBlueprint(root);

    expect(result.appliedPath).toBe(path.join(root, ".blueprint", "dependencies_graph.json"));
    expect(result.plan.application.status).toBe("applied");
    expect(targetNode.depends_on).toContain("task-001-update-docs");
    expect(targetNode.depends_on).toContain("task-002-implement-api");
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "task-001-update-docs", to: "task-003-validate" }));
    expect(targetTask.data.dependencies).toContain("task-001-update-docs");
    expect(lint.errors).toEqual([]);
  });

  it("rejects graph_local dependency additions that create cycles", async () => {
    const root = await makePlannedProject();
    const graphPath = path.join(root, ".blueprint", "dependencies_graph.json");
    const before = await readFile(graphPath, "utf8");
    const result = await reviseBlueprint({
      root,
      change: "Faça task-001-update-docs depender da task-003-validate.",
      apply: true,
    });
    const after = await readFile(graphPath, "utf8");

    expect(result.appliedPath).toBeUndefined();
    expect(result.plan.application.status).toBe("failed");
    expect(result.plan.application.error).toContain("dependency cycle");
    expect(after).toBe(before);
  });

  it("classifies technology premise changes as architecture_subtree", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Mude o banco de Postgres para MongoDB nesta area do plano.",
      dryRun: true,
    });

    expect(result.plan.classification).toBe("architecture_subtree");
    expect(result.plan.rationale).toContain("Detected architecture or technology keyword.");
  });

  it("classifies explicit documentation changes as local_doc", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Atualize integration_guide.md para mencionar blueprint revise e manter validação final.",
      dryRun: true,
    });

    expect(result.plan.classification).toBe("local_doc");
    expect(result.plan.affected_files).toEqual(["integration_guide.md"]);
  });

  it("writes revision records by default", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Atualize integration_guide.md com a nova ordem de validacao.",
    });

    expect(result.writtenPath).toBeDefined();
    const written = JSON.parse(await readFile(result.writtenPath!, "utf8")) as { classification: string };
    expect(written.classification).toBe("local_doc");
  });

  it("applies safe local_doc revisions through an injected rewriter", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Atualize integration_guide.md com a nova ordem de validacao.",
      apply: true,
      localDocRewriter: async (request) => ({
        schema_version: "1.0",
        content: `${request.currentContent}\n## Revision Applied\n\nNova ordem de validacao documentada.\n`,
        summary: "Updated validation order section.",
      }),
    });
    const updated = await readFile(path.join(root, ".blueprint", "integration_guide.md"), "utf8");
    const revision = JSON.parse(await readFile(result.writtenPath!, "utf8")) as {
      application: { status: string; target_file: string };
    };

    expect(result.appliedPath).toBe(path.join(root, ".blueprint", "integration_guide.md"));
    expect(result.plan.application.status).toBe("applied");
    expect(revision.application.status).toBe("applied");
    expect(revision.application.target_file).toBe("integration_guide.md");
    expect(updated).toContain("Nova ordem de validacao documentada.");
  });

  it("applies safe task_local revisions through an injected rewriter", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Adicione criterio de lint no acceptance_contract da task 002 sem mudar outras tasks.",
      apply: true,
      taskRewriter: async (request) => ({
        schema_version: "1.0",
        content: request.currentContent.replace(
          "- API behavior works.",
          "- API behavior works.\n- blueprint lint passes after this task.",
        ),
        summary: "Added lint acceptance criterion.",
      }),
    });
    const updated = await readFile(path.join(root, ".blueprint", "tasks", "002-implement-api.md"), "utf8");
    const revision = JSON.parse(await readFile(result.writtenPath!, "utf8")) as {
      application: { status: string; target_file: string };
    };

    expect(result.appliedPath).toBe(path.join(root, ".blueprint", "tasks", "002-implement-api.md"));
    expect(result.plan.application.status).toBe("applied");
    expect(revision.application.status).toBe("applied");
    expect(revision.application.target_file).toBe("tasks/002-implement-api.md");
    expect(updated).toContain("blueprint lint passes after this task.");
  });

  it("rejects task_local rewrites that change task identity", async () => {
    const root = await makePlannedProject();
    const taskPath = path.join(root, ".blueprint", "tasks", "002-implement-api.md");
    const before = await readFile(taskPath, "utf8");
    const result = await reviseBlueprint({
      root,
      change: "Adicione criterio de lint no acceptance_contract da task 002 sem mudar outras tasks.",
      apply: true,
      taskRewriter: async (request) => ({
        schema_version: "1.0",
        content: request.currentContent.replace("id: task-002-implement-api", "id: task-999-broken"),
        summary: "Changed id unexpectedly.",
      }),
    });
    const after = await readFile(taskPath, "utf8");
    const revision = JSON.parse(await readFile(result.writtenPath!, "utf8")) as {
      application: { status: string; error: string };
    };

    expect(result.appliedPath).toBeUndefined();
    expect(result.plan.application.status).toBe("failed");
    expect(result.plan.application.error).toContain("changed frontmatter id");
    expect(revision.application.status).toBe("failed");
    expect(revision.application.error).toContain("changed frontmatter id");
    expect(after).toBe(before);
  });

  it("does not apply unsupported graph revisions", async () => {
    const root = await makePlannedProject();
    const result = await reviseBlueprint({
      root,
      change: "Reordene o grafo para aumentar paralelismo.",
      apply: true,
      taskRewriter: async () => {
        throw new Error("rewriter should not be called");
      },
    });

    expect(result.appliedPath).toBeUndefined();
    expect(result.plan.application.status).toBe("unsupported");
    expect(result.plan.application.error).toContain("No explicit two-task dependency operation");
  });

  it("parses revised document responses and builds rewrite prompts", () => {
    const parsed = parseRevisedDocument(
      JSON.stringify({
        schema_version: "1.0",
        content: "# Updated\n",
        summary: "Updated document.",
      }),
    );
    const prompt = buildLocalDocRewritePrompt({
      root: "/tmp/project",
      blueprintRoot: "/tmp/project/.blueprint",
      file: "integration_guide.md",
      change: "Atualize guia.",
      currentContent: "# Guide\n",
    });
    const taskPrompt = buildTaskRewritePrompt({
      root: "/tmp/project",
      blueprintRoot: "/tmp/project/.blueprint",
      file: "tasks/002-implement-api.md",
      taskId: "task-002-implement-api",
      change: "Atualize contrato.",
      currentContent:
        "---\nid: task-002-implement-api\ntitle: Implement API\nsuggested_model: codex\ndependencies: []\nrisk_level: 3\n---\n\n<task_objective>\nDo it.\n</task_objective>\n",
      currentMetadata: {
        id: "task-002-implement-api",
        title: "Implement API",
        suggested_model: "codex",
        dependencies: [],
        allowed_paths: ["src/api.ts"],
        forbidden_paths: [".env"],
        risk_level: 3,
        test_commands: [],
      },
    });

    expect(parsed.content).toBe("# Updated\n");
    expect(prompt).toContain("integration_guide.md");
    expect(prompt).toContain("Return ONLY JSON");
    expect(taskPrompt).toContain("task-002-implement-api");
    expect(taskPrompt).toContain("<acceptance_contract>");
    expect(taskPrompt).toContain("Preserve frontmatter dependencies exactly as []");
  });

  it("reads change text from a file and rejects mixed input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-revise-input-test-"));
    const changeFile = path.join(root, "change.txt");
    await writeFile(changeFile, "Atualize README.md.\n", "utf8");

    await expect(readChangeInput("inline", changeFile)).rejects.toThrow("Use either --change or --file");
    await expect(readChangeInput(undefined, changeFile)).resolves.toBe("Atualize README.md.");
  });
});

async function makePlannedProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-revise-test-"));
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
    objective: "Add a feature to a service that currently uses Postgres.",
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
    overview: "Fixture plan for revise classification.",
    assumptions: ["The current persistence layer is Postgres."],
    decisions: ["Keep docs, implementation, and validation separate."],
    risks: ["Database changes may require an architecture subtree revision."],
    integration_notes: ["Run blueprint lint after revise operations."],
    tasks: [
      {
        id: "task-001-update-docs",
        title: "Update docs",
        objective: "Update command documentation.",
        suggested_model: "gemini-3.1-pro-preview",
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
        objective: "Implement API logic that reads from Postgres.",
        suggested_model: "gpt-5.5",
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
      {
        id: "task-003-validate",
        title: "Validate API",
        objective: "Validate API behavior.",
        suggested_model: "gpt-5.5",
        fit: "review",
        dependencies: ["task-002-implement-api"],
        allowed_paths: ["tests/api.test.ts"],
        forbidden_paths: [".env"],
        risk_level: 3,
        test_commands: ["corepack pnpm test"],
        context_rules: ["Only edit tests if needed."],
        execution_prompt: "Run validation and update tests.",
        acceptance_contract: ["Tests pass."],
      },
    ],
  };
}
