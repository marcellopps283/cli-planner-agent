import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { lintBlueprint } from "../src/lint.js";
import { DEFAULT_MODEL_REGISTRY } from "../src/models.js";
import {
  buildPlannerPromptForContext,
  generateBlueprintPlan,
  getPlannerFallbackCandidates,
  normalizeValidationCommands,
  parsePlanAnswers,
  parsePlannerDraft,
  previewBlueprintPlan,
  type PlanAnswers,
  type PlanContext,
  type PlannerDraft,
} from "../src/plan.js";
import { initPlannerProfile } from "../src/profile.js";

describe("blueprint plan generation", () => {
  it("generates lintable task handoffs using the active provider pool", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });

    const result = await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
    });
    const lint = await lintBlueprint(root);
    const implementationTask = await readFile(
      path.join(root, ".blueprint", "tasks", "002-implement-core-work.md"),
      "utf8",
    );
    const manifest = await readFile(path.join(root, ".blueprint", "blueprint.yaml"), "utf8");

    expect(result.taskIds).toEqual([
      "task-001-context-map",
      "task-002-implement-core-work",
      "task-003-integrate-and-validate",
    ]);
    expect(lint.errors).toEqual([]);
    expect(manifest).toContain("status: planned");
    expect(implementationTask).toContain("suggested_model: gpt-5.5");
    expect(implementationTask).not.toContain("claude-opus-4-7");
  });

  it("requires force before replacing existing task files", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
    });

    await expect(
      generateBlueprintPlan({
        root,
        answers: makeAnswers(),
      }),
    ).rejects.toThrow("Existing task files found");
  });

  it("clears previous task files when force is enabled", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
    });
    await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft: makeDraft(),
      force: true,
    });

    const taskFiles = await readdir(path.join(root, ".blueprint", "tasks"));

    expect(taskFiles.sort()).toEqual(["001-custom-analysis.md", "002-custom-build.md", "README.md"]);
  });

  it("generates handoffs from a validated LLM planner draft", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });

    const result = await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft: makeDraft(),
    });
    const lint = await lintBlueprint(root);
    const firstTask = await readFile(path.join(root, ".blueprint", "tasks", "001-custom-analysis.md"), "utf8");

    expect(result.engine).toBe("llm");
    expect(result.taskIds).toEqual(["task-001-custom-analysis", "task-002-custom-build"]);
    expect(lint.errors).toEqual([]);
    expect(firstTask).toContain("suggested_model: gemini-3.1-pro-preview");
    expect(firstTask).toContain("model_rationale: Best long-context model in the active fixture pool.");
    expect(firstTask).toContain("<model_rationale>");
    expect(firstTask).toContain("Acceptable alternatives: gpt-5.5");
  });

  it("calls the LLM planner through the selected exact planner model", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
    });
    const calls: Array<{ provider: string; model?: string }> = [];

    const result = await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
      engine: "llm",
      plannerPromptRunner: async (options) => {
        calls.push({ provider: options.provider, model: options.model });
        return {
          provider: options.provider,
          model: options.model,
          response: JSON.stringify(makeDraft()),
          rawOutput: "",
        };
      },
    });

    expect(result.engine).toBe("llm");
    expect(calls).toEqual([{ provider: "openai", model: "gpt-5.5" }]);
  });

  it("previews task model assignments before writing handoffs", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });

    const preview = await previewBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft: makeDraft(),
    });
    const blueprintFiles = await readdir(path.join(root, ".blueprint"));

    expect(preview.engine).toBe("llm");
    expect(preview.tasks.map((task) => `${task.id}:${task.suggestedModel}`)).toEqual([
      "task-001-custom-analysis:gemini-3.1-pro-preview",
      "task-002-custom-build:gpt-5.5",
    ]);
    expect(preview.tasks[0]?.modelRationale).toContain("Best long-context model");
    expect(preview.tasks[0]?.acceptableAlternatives).toEqual(["gpt-5.5"]);
    expect(blueprintFiles).not.toContain("dependencies_graph.json");
    expect(blueprintFiles).not.toContain("tasks");
  });

  it("parses planner drafts from fenced JSON", () => {
    const draft = parsePlannerDraft(`\`\`\`json\n${JSON.stringify(makeDraft())}\n\`\`\``);

    expect(draft.tasks).toHaveLength(2);
  });

  it("loads the golden planner fixture and generates lintable artifacts", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
    });

    const draft = await loadDraftFixture("golden-valid.json");
    const result = await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });
    const lint = await lintBlueprint(root);

    expect(result.engine).toBe("llm");
    expect(result.taskIds).toEqual([
      "task-001-document-contract",
      "task-002-harden-schema",
      "task-003-verify-golden-fixtures",
    ]);
    expect(lint.errors).toEqual([]);
  });

  it("normalizes pnpm validation commands from planner answers", () => {
    const parsed = parsePlanAnswers({
      ...makeAnswers(),
      validationCommands: [
        "pnpm typecheck",
        "pnpm test run tests/tui.test.ts",
        "corepack pnpm test run tests/providers.test.ts",
        "corepack pnpm build",
      ],
    });

    expect(parsed.validationCommands).toEqual([
      "corepack pnpm typecheck",
      "corepack pnpm test tests/tui.test.ts",
      "corepack pnpm test tests/providers.test.ts",
      "corepack pnpm build",
    ]);
    expect(normalizeValidationCommands(["pnpm test run tests/tui.test.ts"])).toEqual([
      "corepack pnpm test tests/tui.test.ts",
    ]);
  });

  it("raises risk for global TUI and fallback planner tasks", async () => {
    const root = await makeTempProject();
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "src", "tui.ts"), "export const tui = true;\n", "utf8");
    await writeFile(path.join(root, "tests", "plan.test.ts"), "export {};\n", "utf8");
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
    });
    const draft = makeDraft();
    draft.tasks[1]!.risk_level = 2;
    draft.tasks[1]!.objective = "Refactor the global TUI orchestrator and fallback flow.";
    draft.tasks[1]!.allowed_paths = ["src/tui.ts", "tests/plan.test.ts"];

    await generateBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });
    const task = await readFile(path.join(root, ".blueprint", "tasks", "002-custom-build.md"), "utf8");

    expect(task).toContain("risk_level: 5");
    expect(task).toContain("Risk floor raised from 2 to 5");
    expect(task).toContain("Risk floor: touches global CLI or TUI orchestration files");
  });

  it("rejects planner drafts that suggest models outside the active pool", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
    });
    const draft = await loadDraftFixture("unavailable-model.json");

    await expect(
      generateBlueprintPlan({
        root,
        answers: makeAnswers(),
        draft,
      }),
    ).rejects.toThrow("Planner draft suggested unavailable model claude-opus-4-7");
  });

  it("rejects planner drafts that list unavailable alternative models", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
    });
    const draft = makeDraft();
    draft.tasks[0]!.acceptable_alternatives = ["claude-opus-4-7"];

    await expect(
      generateBlueprintPlan({
        root,
        answers: makeAnswers(),
        draft,
      }),
    ).rejects.toThrow("Planner draft suggested unavailable alternative model claude-opus-4-7");
  });

  it("upgrades underfit planner model suggestions for high-risk tasks", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "google",
    });
    const draft = makeDraft();
    draft.tasks = [
      {
        id: "task-001-hard-routing",
        title: "Hard routing refactor",
        objective: "Redesign model routing for complex agentic planning decisions.",
        suggested_model: "gemini-3.1-flash-lite-preview",
        model_rationale: "Cheap utility model should save quota.",
        acceptable_alternatives: ["gpt-5.4-nano", "gemini-3.1-flash-lite-preview"],
        fit: "architecture",
        dependencies: [],
        allowed_paths: ["src/plannerEngine.ts", "src/models.ts", "src/tui.ts"],
        forbidden_paths: [".env"],
        risk_level: 8,
        test_commands: ["corepack pnpm test"],
        context_rules: ["Preserve provider contracts."],
        execution_prompt: "Plan and implement a high-risk architecture refactor for model routing.",
        acceptance_contract: ["Complex tasks are not routed to utility models."],
      },
    ];

    const preview = await previewBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });

    expect(preview.tasks[0]!.suggestedModel).toBe("gpt-5.5");
    expect(preview.tasks[0]!.modelRationale).toContain(
      "Routing guard changed suggested_model from gemini-3.1-flash-lite-preview to gpt-5.5",
    );
    expect(preview.tasks[0]!.acceptableAlternatives).not.toContain("gpt-5.4-nano");
    expect(preview.tasks[0]!.acceptableAlternatives).not.toContain("gemini-3.1-flash-lite-preview");
  });

  it("keeps utility models for low-risk tiny edits", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    const draft = makeDraft();
    draft.tasks = [
      {
        id: "task-001-copy-edit",
        title: "Copy edit",
        objective: "Rename a README heading without changing behavior.",
        suggested_model: "gpt-5.4-nano",
        model_rationale: "Best cheap model for tiny edit work.",
        acceptable_alternatives: ["gemini-3.1-flash-lite-preview"],
        fit: "tiny_edit",
        dependencies: [],
        allowed_paths: ["README.md"],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: [],
        context_rules: ["Only edit the requested heading."],
        execution_prompt: "Update one README heading.",
        acceptance_contract: ["No source files change."],
      },
    ];

    const preview = await previewBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });

    expect(preview.tasks[0]!.suggestedModel).toBe("gpt-5.4-nano");
    expect(preview.tasks[0]!.modelRationale).not.toContain("Routing guard changed");
  });

  it("downgrades overfit frontier choices for low-risk tiny edits", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    const draft = makeDraft();
    draft.tasks = [
      {
        id: "task-001-fixture-edit",
        title: "Fixture edit",
        objective: "Update one JSON fixture value.",
        suggested_model: "gpt-5.5",
        model_rationale: "Use the strongest model for safety.",
        acceptable_alternatives: ["gpt-5.4-nano"],
        fit: "tiny_edit",
        dependencies: [],
        allowed_paths: ["tests/fixtures/example.json"],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: [],
        context_rules: ["Change only the requested fixture value."],
        execution_prompt: "Update one fixture value.",
        acceptance_contract: ["Only one fixture changes."],
      },
    ];

    const preview = await previewBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });

    expect(preview.tasks[0]!.suggestedModel).toBe("gpt-5.4-nano");
    expect(preview.tasks[0]!.modelRationale).toContain(
      "Routing guard changed suggested_model from gpt-5.5 to gpt-5.4-nano",
    );
  });

  it("uses risk floors before judging model fit", async () => {
    const root = await makeTempProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
    });
    const draft = makeDraft();
    draft.tasks = [
      {
        id: "task-001-tui-workflow",
        title: "TUI workflow polish",
        objective: "Refactor the unified chat workflow and semantic checkbox behavior.",
        suggested_model: "gpt-5.4-nano",
        model_rationale: "Low stated risk means a small worker is enough.",
        acceptable_alternatives: ["gemini-3.1-flash-lite-preview"],
        fit: "refactor",
        dependencies: [],
        allowed_paths: ["src/tui.ts", "src/cli.ts"],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: ["corepack pnpm test tests/tui.test.ts"],
        context_rules: ["Keep the workbench stable."],
        execution_prompt: "Adjust the interactive flow in the global TUI surface.",
        acceptance_contract: ["TUI tests pass."],
      },
    ];

    const preview = await previewBlueprintPlan({
      root,
      answers: makeAnswers(),
      draft,
    });

    expect(preview.tasks[0]!.riskLevel).toBe(5);
    expect(preview.tasks[0]!.suggestedModel).not.toBe("gpt-5.4-nano");
    expect(preview.tasks[0]!.modelRationale).toContain("Risk floor raised from 2 to 5");
    expect(preview.tasks[0]!.modelRationale).toContain("Routing guard changed");
  });

  it("rejects planner drafts with unsupported fit values", async () => {
    const raw = await readFixture("invalid-fit.json");

    expect(() => parsePlannerDraft(raw)).toThrow("Invalid option");
  });

  it("includes a concrete schema example and active model ids in the planner prompt", () => {
    const prompt = buildPlannerPromptForContext(makePlanContext(), makeAnswers());

    expect(prompt).toContain("Example of the expected style:");
    expect(prompt).toContain("task-001-map-context");
    expect(prompt).toContain("model_rationale");
    expect(prompt).toContain("acceptable_alternatives");
    expect(prompt).toContain("reasoning_efforts");
    expect(prompt).toContain("default_reasoning_effort");
    expect(prompt).toContain("routing_scorecards");
    expect(prompt).toContain("low_risk_order");
    expect(prompt).toContain("high_risk_order");
    expect(prompt).toContain("declared_dependencies");
    expect(prompt).toContain("not as a lock that prevents architectural brainstorming");
    expect(prompt).toContain("present them as options with tradeoffs until the user chooses");
    expect(prompt).toContain("Never recommend a framework, package, library, build tool, database, or test framework because it is installed globally");
    expect(prompt).toContain("gpt-5.5");
    expect(prompt).toContain("gemini-3.1-pro-preview");
    expect(prompt).not.toContain("claude-opus-4-7");
  });

  it("sorts planner fallback candidates inside the active model pool", () => {
    const candidates = getPlannerFallbackCandidates(makePlanContext(), "gemini-3.1-pro-preview");

    expect(candidates.map((candidate) => candidate.model)).toEqual(["gpt-5.5"]);
    expect(candidates[0]?.reason).toContain("planning=0.99");
  });
});

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-plan-test-"));
  await writeFile(path.join(root, "README.md"), "# Temp project\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

function makeAnswers(): PlanAnswers {
  return {
    projectSummary: "A TypeScript CLI that generates AI handoff plans.",
    objective: "Add a simple planning flow that writes task handoffs.",
    successCriteria: ["The plan creates architecture, graph, and task files.", "The generated blueprint passes lint."],
    constraints: ["Do not use Anthropic while quota is unavailable."],
    outOfScope: ["Running workers automatically."],
    targetPaths: ["src/plan.ts", "src/cli.ts", "tests/plan.test.ts"],
    validationCommands: ["corepack pnpm typecheck", "corepack pnpm test"],
    riskLevel: 5,
    notes: ["Keep the flow deterministic for tests."],
  };
}

function makeDraft(): PlannerDraft {
  return {
    schema_version: "1.0",
    overview: "Custom LLM generated plan.",
    assumptions: ["Use the active provider pool."],
    decisions: ["Split analysis and implementation."],
    risks: ["Provider output must stay schema-valid."],
    integration_notes: ["Run lint after writing artifacts."],
    tasks: [
      {
        id: "task-001-custom-analysis",
        title: "Custom analysis",
        objective: "Analyze the current planner flow.",
        suggested_model: "gemini-3.1-pro-preview",
        model_rationale: "Best long-context model in the active fixture pool.",
        acceptable_alternatives: ["gpt-5.5"],
        fit: "long_context",
        dependencies: [],
        allowed_paths: [],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: [],
        context_rules: ["Read-only task."],
        execution_prompt: "Inspect the planner flow and summarize relevant contracts.",
        acceptance_contract: ["No files are modified."],
      },
      {
        id: "task-002-custom-build",
        title: "Custom build",
        objective: "Implement the planned change.",
        suggested_model: "gpt-5.5",
        model_rationale: "Best coding-heavy model in the active fixture pool.",
        acceptable_alternatives: ["gemini-3.1-pro-preview"],
        fit: "coding_heavy",
        dependencies: ["task-001-custom-analysis"],
        allowed_paths: ["src/plan.ts", "tests/plan.test.ts"],
        forbidden_paths: [".env"],
        risk_level: 4,
        test_commands: ["corepack pnpm test"],
        context_rules: ["Stay in allowed paths."],
        execution_prompt: "Implement the planned change and keep it scoped.",
        acceptance_contract: ["Tests pass."],
      },
    ],
  };
}

async function loadDraftFixture(name: string): Promise<PlannerDraft> {
  return parsePlannerDraft(await readFixture(name));
}

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), "tests", "fixtures", "planner-drafts", name), "utf8");
}

function makePlanContext(): PlanContext {
  return {
    root: "/tmp/example",
    profile: {
      schema_version: "1.0",
      name: "default",
      planner_provider: "google",
      planner_model: "gemini-3.1-pro-preview",
      planner_reasoning_effort: "thinking_budget:-1",
      available_providers: ["openai", "google"],
      available_models: ["gpt-5.5", "gemini-3.1-pro-preview"],
      model_reasoning_efforts: {
        "gpt-5.5": "xhigh",
        "gemini-3.1-pro-preview": "thinking_budget:-1",
      },
      excluded_providers: ["anthropic"],
      model_registry: {
        source: "bundled",
      },
      routing: {
        prefer_available_only: true,
        allow_provider_fallback: true,
        require_confirmation_for_fallback: true,
      },
      live_checks: {
        require_before_plan: false,
      },
      notes: [],
    },
    registry: DEFAULT_MODEL_REGISTRY,
    doctor: {
      root: "/tmp/example",
      canonicalFiles: ["README.md", "package.json"],
      manifests: ["package.json"],
      stack: ["node", "typescript"],
      scripts: {
        test: "vitest run",
        typecheck: "tsc --noEmit",
      },
      dependencyManifests: [
        {
          path: "package.json",
          dependencies: ["commander", "zod"],
          devDependencies: ["vitest"],
          peerDependencies: [],
          optionalDependencies: [],
        },
      ],
      topLevelDirs: ["src", "tests"],
      inventoryFiles: [
        {
          path: "src/plan.ts",
          extension: "ts",
          sizeBytes: 1200,
          markers: ["source"],
        },
      ],
      markdownHeadings: {
        "README.md": ["Example"],
      },
      fileCount: 4,
      blockedPatterns: [".env", "node_modules/**"],
      warnings: [],
    },
  };
}
