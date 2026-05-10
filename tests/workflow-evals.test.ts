import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_REGISTRY } from "../src/models.js";
import { previewBlueprintPlan, type PlanAnswers, type PlannerDraft } from "../src/plan.js";
import { initPlannerProfile } from "../src/profile.js";
import { runTuiAction } from "../src/tui.js";

describe("fake idea workflow evaluations", () => {
  it("keeps greenfield stack ideas conversational until the user chooses", async () => {
    const root = await makeEvalProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
    });
    let prompt = "";

    const result = await runTuiAction({
      root,
      actionId: "agent-workflow",
      agentRequest: "Quero criar um CRM novo, mas ainda nao sei se uso React, Next, Svelte ou algo mais simples.",
      plannerPromptRunner: async (options) => {
        prompt = options.prompt;

        return {
          provider: options.provider,
          model: options.model,
          rawOutput: "",
          response: JSON.stringify({
            schema_version: "1.0",
            user_request: "Quero criar um CRM novo, mas ainda nao sei se uso React, Next, Svelte ou algo mais simples.",
            planner: {
              provider: options.provider,
              model: options.model,
              reasoning_effort: options.reasoningEffort,
            },
            project_state: {
              title: "CRM greenfield",
              summary: "O usuario ainda esta escolhendo stack e escopo, entao o planner deve comparar caminhos antes de gerar handoffs.",
              current_phase: "Brainstorming stack options",
              health: "needs_input",
              confidence: 0.62,
            },
            messages: [
              {
                role: "planner",
                content: "Podemos comparar React puro, Next e Svelte por ergonomia, deploy, dados e complexidade antes de decidir.",
              },
            ],
            checklist: [
              {
                id: "understand_goal",
                label: "Entender produto desejado",
                status: "in_progress",
                validated_by: "active planner model",
                evidence: "Produto geral existe, mas stack e escopo ainda estao abertos.",
                interactive: true,
              },
            ],
            questions: [
              {
                id: "stack_direction",
                question: "Voce quer otimizar por velocidade de prototipo, app full-stack ou simplicidade operacional?",
                why: "A resposta muda se a melhor opcao e React, Next, Svelte ou uma stack menor.",
                required: true,
              },
            ],
            next_action: {
              type: "ask_user",
              label: "Escolher criterio de stack",
              prompt: "Escolha o criterio principal antes do preview tecnico.",
            },
          }),
        };
      },
      recordHistory: false,
    });

    expect(result.status).toBe("ok");
    expect(result.canApply).toBe(false);
    expect(result.planAnswers).toBeUndefined();
    expect(result.lines).toContain("health needs_input");
    expect(result.lines).toContain("next ask_user Escolher criterio de stack");
    expect(prompt).toContain("Use brainstorming mode while requirements are incomplete");
    expect(prompt).toContain("present viable options with tradeoffs");
    expect(prompt).toContain("not as a lock that limits the user's architectural options");
    expect(prompt).toContain("Do not force a plan too early");
  });

  it("routes fake implementation ideas to capable models by complexity", async () => {
    const root = await makeEvalProject();
    await initPlannerProfile({
      root,
      providers: ["openai", "google"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.5",
    });

    const preview = await previewBlueprintPlan({
      root,
      answers: makeEvalAnswers(),
      draft: makeMixedComplexityDraft(),
    });
    const tasksById = new Map(preview.tasks.map((task) => [task.id, task]));

    expect(tasksById.get("task-001-copy-polish")?.suggestedModel).toBe("gpt-5.4-nano");
    expect(tasksById.get("task-003-tui-shortcuts")?.suggestedModel).not.toBe("gpt-5.4-nano");
    expect(modelTier(tasksById.get("task-003-tui-shortcuts")?.suggestedModel)).not.toBe("utility");
    expect(tasksById.get("task-004-routing-contract")?.suggestedModel).toBe("gpt-5.5");

    for (const draftTask of makeMixedComplexityDraft().tasks) {
      const previewTask = tasksById.get(draftTask.id);

      expect(previewTask).toBeDefined();
      expectModelCapable(previewTask!.suggestedModel, draftTask.fit, previewTask!.riskLevel);

      for (const alternative of previewTask!.acceptableAlternatives) {
        expectModelCapable(alternative, draftTask.fit, previewTask!.riskLevel);
      }
    }
  });

  it("upgrades within a google-only pool instead of leaking to excluded providers", async () => {
    const root = await makeEvalProject();
    await initPlannerProfile({
      root,
      providers: ["google"],
      models: ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"],
      plannerProvider: "google",
      plannerModel: "gemini-3.1-pro-preview",
    });

    const preview = await previewBlueprintPlan({
      root,
      answers: makeEvalAnswers(),
      draft: {
        ...makeMixedComplexityDraft(),
        tasks: [
          {
            ...makeMixedComplexityDraft().tasks[3]!,
            suggested_model: "gemini-3.1-flash-lite-preview",
            acceptable_alternatives: ["gemini-3.1-flash-lite-preview"],
            dependencies: [],
          },
        ],
      },
    });

    expect(preview.tasks[0]!.suggestedModel).toBe("gemini-3.1-pro-preview");
    expect(preview.tasks[0]!.acceptableAlternatives).not.toContain("gpt-5.5");
    expect(preview.tasks[0]!.modelRationale).toContain(
      "Routing guard changed suggested_model from gemini-3.1-flash-lite-preview to gemini-3.1-pro-preview",
    );
  });

  it("refuses high-risk fake tasks when the selected pool has no capable model", async () => {
    const root = await makeEvalProject();
    await initPlannerProfile({
      root,
      providers: ["openai"],
      models: ["gpt-5.4-nano"],
      plannerProvider: "openai",
      plannerModel: "gpt-5.4-nano",
    });

    await expect(
      previewBlueprintPlan({
        root,
        answers: makeEvalAnswers(),
        draft: {
          ...makeMixedComplexityDraft(),
          tasks: [
            {
              ...makeMixedComplexityDraft().tasks[3]!,
              suggested_model: "gpt-5.4-nano",
              acceptable_alternatives: [],
              dependencies: [],
            },
          ],
        },
      }),
    ).rejects.toThrow("No capable active model for risk 9 architecture task");
  });
});

async function makeEvalProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-workflow-eval-"));

  await writeFile(path.join(root, "README.md"), "# Workflow eval\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        scripts: {
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          commander: "^14.0.0",
          zod: "^4.0.0",
        },
        devDependencies: {
          vitest: "^4.0.0",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return root;
}

function makeEvalAnswers(): PlanAnswers {
  return {
    projectSummary: "A TypeScript CLI planner-agent that generates AI handoff artifacts.",
    objective: "Evaluate fake user ideas and route each planned task to a capable model.",
    successCriteria: [
      "Brainstorming stays conversational until decisions are confirmed.",
      "Simple edits use cheap capable models.",
      "High-risk architecture tasks use frontier or strong specialized models.",
      "The planner refuses handoffs when the selected pool has no capable model.",
    ],
    constraints: ["Do not use models outside the selected active pool."],
    outOfScope: ["Executing worker tasks directly."],
    targetPaths: ["README.md", "src/tui.ts", "src/plan.ts", "src/models.ts", "tests/workflow-evals.test.ts"],
    validationCommands: ["corepack pnpm test tests/workflow-evals.test.ts"],
    riskLevel: 6,
    notes: ["Synthetic workflow evaluation scenarios."],
  };
}

function makeMixedComplexityDraft(): PlannerDraft {
  return {
    schema_version: "1.0",
    overview: "Synthetic mixed-complexity workflow evaluation.",
    assumptions: ["The planner can brainstorm freely but handoffs require confirmed decisions."],
    decisions: ["Use active model IDs only."],
    risks: ["Underfitting complex work would make handoffs unsafe."],
    integration_notes: ["Run the workflow evaluation tests after routing changes."],
    tasks: [
      {
        id: "task-001-copy-polish",
        title: "Copy polish",
        objective: "Tighten one README paragraph without changing behavior.",
        suggested_model: "gpt-5.5",
        model_rationale: "Strongest model is safest.",
        acceptable_alternatives: ["gpt-5.4-nano", "gemini-3.1-flash-lite-preview"],
        fit: "tiny_edit",
        dependencies: [],
        allowed_paths: ["README.md"],
        forbidden_paths: [".env"],
        risk_level: 2,
        test_commands: [],
        context_rules: ["Only edit the target paragraph."],
        execution_prompt: "Update one README paragraph.",
        acceptance_contract: ["No source code changes."],
      },
      {
        id: "task-002-fixture-schema",
        title: "Fixture schema cleanup",
        objective: "Normalize one JSON fixture shape and keep parser tests aligned.",
        suggested_model: "gpt-5.4-nano",
        model_rationale: "Cheap structured output worker is enough.",
        acceptable_alternatives: ["gemini-3.1-flash-lite-preview"],
        fit: "tiny_edit",
        dependencies: ["task-001-copy-polish"],
        allowed_paths: ["tests/fixtures/workflow.json", "tests/workflow-evals.test.ts"],
        forbidden_paths: [".env"],
        risk_level: 3,
        test_commands: ["corepack pnpm test tests/workflow-evals.test.ts"],
        context_rules: ["Keep the fixture edit mechanical."],
        execution_prompt: "Normalize the fixture and update the focused expectation.",
        acceptance_contract: ["Focused workflow test passes."],
      },
      {
        id: "task-003-tui-shortcuts",
        title: "TUI slash shortcut polish",
        objective: "Adjust slash command keyboard navigation in the unified chat surface.",
        suggested_model: "gpt-5.4-nano",
        model_rationale: "Small model should be enough for UI polish.",
        acceptable_alternatives: ["gemini-3.1-flash-lite-preview"],
        fit: "refactor",
        dependencies: ["task-002-fixture-schema"],
        allowed_paths: ["src/tui.ts", "tests/tui.test.ts"],
        forbidden_paths: [".env"],
        risk_level: 6,
        test_commands: ["corepack pnpm test tests/tui.test.ts"],
        context_rules: ["Do not disturb saved session behavior."],
        execution_prompt: "Polish slash command navigation in the TUI chat.",
        acceptance_contract: ["TUI tests pass.", "Keyboard navigation remains stable."],
      },
      {
        id: "task-004-routing-contract",
        title: "Routing contract hardening",
        objective: "Harden provider/model routing so complex architecture work cannot use weak utility models.",
        suggested_model: "gemini-3.1-flash-lite-preview",
        model_rationale: "Cheap long-context model can inspect the registry.",
        acceptable_alternatives: ["gpt-5.4-nano", "gemini-3.1-flash-lite-preview"],
        fit: "architecture",
        dependencies: ["task-003-tui-shortcuts"],
        allowed_paths: ["src/plan.ts", "src/models.ts", "docs/SPECS/provider_routing.md"],
        forbidden_paths: [".env"],
        risk_level: 9,
        test_commands: ["corepack pnpm test tests/plan.test.ts tests/workflow-evals.test.ts"],
        context_rules: ["Preserve active provider pool restrictions."],
        execution_prompt: "Harden the routing contract and tests for high-risk model assignments.",
        acceptance_contract: ["Weak models are never assigned to high-risk architecture tasks."],
      },
    ],
  };
}

function expectModelCapable(modelId: string, fit: string, riskLevel: number): void {
  const model = DEFAULT_MODEL_REGISTRY.find((entry) => entry.id === modelId);

  expect(model, `model ${modelId} must exist in registry`).toBeDefined();
  expect(model!.task_fit[fit] ?? 0, `${modelId} fit for ${fit}`).toBeGreaterThanOrEqual(minimumFitForEval(fit, riskLevel));

  if (riskLevel >= 5 && fit !== "tiny_edit") {
    expect(model!.tier, `${modelId} tier for risk ${riskLevel} ${fit}`).not.toBe("utility");
  }
}

function modelTier(modelId: string | undefined): string | undefined {
  return DEFAULT_MODEL_REGISTRY.find((entry) => entry.id === modelId)?.tier;
}

function minimumFitForEval(fit: string, riskLevel: number): number {
  if (fit === "tiny_edit") {
    return riskLevel >= 7 ? 0.8 : 0.55;
  }

  if (riskLevel >= 8) {
    return 0.84;
  }

  if (riskLevel >= 7) {
    return 0.8;
  }

  if (riskLevel >= 5) {
    return 0.7;
  }

  return 0.45;
}
