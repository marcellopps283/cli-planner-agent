import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiline,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import fg from "fast-glob";
import { stringify } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { inspectProject, type ProjectDoctorReport } from "./doctor.js";
import { lintBlueprint } from "./lint.js";
import { loadPlannerProfile } from "./profile.js";
import { extractJsonObject, runProviderPrompt } from "./providerPrompt.js";
import { loadModelRegistryForProfile } from "./registry.js";
import {
  type BlueprintManifest,
  type BlueprintTaskMetadata,
  type DependencyGraph,
  type ModelRegistryEntry,
  type PlannerProfile,
} from "./schemas.js";

const PlanAnswersSchema = z.object({
  projectSummary: z.string().min(1),
  objective: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([]),
  targetPaths: z.array(z.string().min(1)).default([]),
  validationCommands: z.array(z.string().min(1)).default([]),
  riskLevel: z.number().int().min(1).max(10).default(5),
  notes: z.array(z.string().min(1)).default([]),
});

export type PlanAnswers = z.infer<typeof PlanAnswersSchema>;

const PlanEngineSchema = z.enum(["deterministic", "llm"]);
export type PlanEngine = z.infer<typeof PlanEngineSchema>;

const PlannerTaskFitSchema = z.enum([
  "planning",
  "architecture",
  "coding_heavy",
  "review",
  "refactor",
  "tiny_edit",
  "long_context",
]);

const PlannerDraftTaskSchema = z.object({
  id: z.string().regex(/^task-\d{3}-[a-z0-9-]+$/u),
  title: z.string().min(1),
  objective: z.string().min(1),
  suggested_model: z.string().min(1).optional(),
  fit: PlannerTaskFitSchema.default("coding_heavy"),
  dependencies: z.array(z.string().min(1)).default([]),
  allowed_paths: z.array(z.string().min(1)).default([]),
  forbidden_paths: z.array(z.string().min(1)).default([]),
  risk_level: z.number().int().min(1).max(10),
  test_commands: z.array(z.string().min(1)).default([]),
  context_rules: z.array(z.string().min(1)).min(1),
  execution_prompt: z.string().min(1),
  acceptance_contract: z.array(z.string().min(1)).min(1),
});

export const PlannerDraftSchema = z.object({
  schema_version: z.literal("1.0"),
  overview: z.string().min(1),
  assumptions: z.array(z.string().min(1)).default([]),
  decisions: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  integration_notes: z.array(z.string().min(1)).default([]),
  tasks: z.array(PlannerDraftTaskSchema).min(1).max(12),
});

export type PlannerDraft = z.infer<typeof PlannerDraftSchema>;

export interface PlanCommandOptions {
  root: string;
  answersPath?: string;
  engine?: PlanEngine;
  fallback?: boolean;
  plannerTimeoutMs?: number;
  force?: boolean;
  yes?: boolean;
}

export interface GeneratePlanOptions {
  root: string;
  answers: PlanAnswers;
  engine?: PlanEngine;
  plannerTimeoutMs?: number;
  draft?: PlannerDraft;
  force?: boolean;
}

export interface GeneratePlanResult {
  root: string;
  files: string[];
  taskIds: string[];
  engine: PlanEngine;
}

export interface PlanContext {
  root: string;
  profile: PlannerProfile;
  registry: ModelRegistryEntry[];
  doctor: ProjectDoctorReport;
}

interface PlannedTask {
  id: string;
  title: string;
  filename: string;
  suggestedModel: ModelRegistryEntry;
  dependencies: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  riskLevel: number;
  testCommands: string[];
  objective: string;
  contextRules: string[];
  executionPrompt: string;
  acceptanceContract: string[];
}

interface PlanBuild {
  engine: PlanEngine;
  overview: string;
  assumptions: string[];
  decisions: string[];
  risks: string[];
  integrationNotes: string[];
  tasks: PlannedTask[];
}

export async function runPlanCommand(options: PlanCommandOptions): Promise<void> {
  const root = path.resolve(options.root);
  const context = await loadPlanContext(root);
  const answers = options.answersPath ? await readAnswersFile(options.answersPath) : await collectPlanAnswers(context);

  if (!options.yes && !options.answersPath) {
    const approved = await confirmPlan(context, answers);

    if (!approved) {
      cancel("Planning cancelled.");
      return;
    }
  }

  const engine = options.engine ?? "deterministic";
  let result: GeneratePlanResult;

  try {
    result = await generateBlueprintPlan({
      root,
      answers,
      engine,
      plannerTimeoutMs: options.plannerTimeoutMs,
      force: options.force ?? options.yes ?? Boolean(options.answersPath),
    });
  } catch (error) {
    if (engine !== "llm" || !options.fallback) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.warn(`LLM planner failed: ${message}`);

    if (!options.yes) {
      const approved = await confirm({
        message: "Usar fallback deterministico e continuar?",
        initialValue: true,
      });

      if (isCancel(approved) || !approved) {
        cancel("Planning cancelled.");
        return;
      }
    }

    result = await generateBlueprintPlan({
      root,
      answers,
      engine: "deterministic",
      force: true,
    });
  }
  const lint = await lintBlueprint(root);

  for (const warning of lint.warnings) {
    log.warn(warning);
  }

  if (lint.errors.length > 0) {
    for (const error of lint.errors) {
      log.error(error);
    }

    throw new Error("Generated blueprint failed lint.");
  }

  outro(`Generated ${result.files.length} blueprint files with ${result.taskIds.length} tasks using ${result.engine}.`);
}

export async function generateBlueprintPlan(options: GeneratePlanOptions): Promise<GeneratePlanResult> {
  const root = path.resolve(options.root);
  const context = await loadPlanContext(root);
  const answers = PlanAnswersSchema.parse(options.answers);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);

  if (!options.force) {
    await assertPlanCanBeWritten(blueprintRoot);
  }

  await mkdir(path.join(blueprintRoot, "tasks"), { recursive: true });

  if (options.force) {
    await clearExistingTaskFiles(blueprintRoot);
  }

  const plan = await buildPlan(context, answers, options);
  const tasks = plan.tasks;
  const manifest: BlueprintManifest = {
    schema_version: "1.0",
    project_name: path.basename(root),
    created_at: new Date().toISOString(),
    planner_provider: context.profile.planner_provider,
    planner_model: context.profile.planner_model,
    available_providers: context.profile.available_providers,
    artifact_root: ".blueprint",
    status: "planned",
  };
  const graph = buildDependencyGraph(tasks);
  const files = [
    ["blueprint.yaml", stringify(manifest)],
    ["architecture.md", renderArchitecture(context, answers, plan)],
    ["assumptions.md", renderAssumptions(context, answers, plan)],
    ["decisions.md", renderDecisions(context, answers, plan)],
    ["risks.md", renderRisks(context, answers, plan)],
    ["dependencies_graph.json", `${JSON.stringify(graph, null, 2)}\n`],
    ["integration_guide.md", renderIntegrationGuide(context, answers, plan)],
    ["tasks/README.md", renderTasksReadme(tasks)],
    ...tasks.map((task) => [path.join("tasks", task.filename), renderTask(task)] as const),
  ] as const;
  const written: string[] = [];

  for (const [relativePath, content] of files) {
    const absolutePath = path.join(blueprintRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    written.push(path.relative(root, absolutePath));
  }

  return {
    root,
    files: written,
    taskIds: tasks.map((task) => task.id),
    engine: plan.engine,
  };
}

async function loadPlanContext(root: string): Promise<PlanContext> {
  const profileResult = await loadPlannerProfile(root);

  if (profileResult.errors.length > 0 || !profileResult.profile) {
    throw new Error(`Profile is not ready. Run blueprint profile init first.\n${profileResult.errors.join("\n")}`);
  }

  const registryResult = await loadModelRegistryForProfile(root, profileResult.profile);

  if (registryResult.errors.length > 0 || !registryResult.registry) {
    throw new Error(`Model registry is not ready.\n${registryResult.errors.join("\n")}`);
  }

  const doctor = await inspectProject(root);

  return {
    root,
    profile: profileResult.profile,
    registry: registryResult.registry.models,
    doctor,
  };
}

async function collectPlanAnswers(context: PlanContext): Promise<PlanAnswers> {
  intro("blueprint plan");
  note(
    [
      `planner: ${context.profile.planner_provider} / ${context.profile.planner_model}`,
      `providers: ${context.profile.available_providers.join(", ")}`,
      `files visible to inventory: ${context.doctor.fileCount}`,
      `canonical docs: ${context.doctor.canonicalFiles.join(", ") || "none"}`,
    ].join("\n"),
    "Context",
  );

  const projectSummary = await promptText("Como voce resumiria este projeto em uma frase?");
  const objective = await promptText("Qual mudanca ou entrega voce quer planejar agora?");
  const successCriteria = await promptList("Quais criterios definem sucesso? Uma linha por criterio.");
  const constraints = await promptList("Quais restricoes tecnicas ou de negocio devem ser respeitadas?", {
    optional: true,
  });
  const outOfScope = await promptList("O que explicitamente fica fora do escopo?", { optional: true });
  const targetPaths = await promptList("Quais paths provavelmente serao tocados?", { optional: true });
  const validationCommands = await promptList("Quais comandos devem validar a entrega?", {
    optional: true,
    defaultValue: inferValidationCommands(context.doctor).join("\n"),
  });
  const riskLevel = await select({
    message: "Qual o risco geral do trabalho?",
    initialValue: 5,
    options: [
      { value: 3, label: "Baixo", hint: "mudanca localizada" },
      { value: 5, label: "Medio", hint: "algumas integracoes" },
      { value: 8, label: "Alto", hint: "arquitetura, dados ou fluxo critico" },
    ],
  });

  if (isCancel(riskLevel)) {
    cancel("Planning cancelled.");
    process.exit(0);
  }

  const notes = await promptList("Alguma observacao adicional para os workers?", { optional: true });

  return PlanAnswersSchema.parse({
    projectSummary,
    objective,
    successCriteria,
    constraints,
    outOfScope,
    targetPaths,
    validationCommands,
    riskLevel,
    notes,
  });
}

async function confirmPlan(context: PlanContext, answers: PlanAnswers): Promise<boolean> {
  note(
    [
      `objective: ${answers.objective}`,
      `tasks: 3 sequential handoffs`,
      `planner: ${context.profile.planner_model}`,
      `active providers: ${context.profile.available_providers.join(", ")}`,
      `validation: ${answers.validationCommands.join(" && ") || "manual acceptance only"}`,
    ].join("\n"),
    "Executive Summary",
  );

  const approved = await confirm({
    message: "Gerar arquivos em .blueprint/?",
    initialValue: true,
  });

  if (isCancel(approved)) {
    return false;
  }

  return approved;
}

async function readAnswersFile(answersPath: string): Promise<PlanAnswers> {
  const raw = await readFile(path.resolve(answersPath), "utf8");
  return PlanAnswersSchema.parse(JSON.parse(raw));
}

async function assertPlanCanBeWritten(blueprintRoot: string): Promise<void> {
  const existingTasks = await fg(["tasks/*.md", "!tasks/README.md"], {
    cwd: blueprintRoot,
    onlyFiles: true,
  });

  if (existingTasks.length > 0) {
    throw new Error("Existing task files found. Use --force to replace generated plan artifacts.");
  }
}

async function clearExistingTaskFiles(blueprintRoot: string): Promise<void> {
  const existingTasks = await fg(["tasks/*.md", "!tasks/README.md"], {
    cwd: blueprintRoot,
    onlyFiles: true,
  });

  await Promise.all(existingTasks.map((taskFile) => rm(path.join(blueprintRoot, taskFile), { force: true })));
}

async function buildPlan(
  context: PlanContext,
  answers: PlanAnswers,
  options: GeneratePlanOptions,
): Promise<PlanBuild> {
  if (options.draft) {
    return buildPlanFromDraft(context, answers, options.draft);
  }

  if (options.engine === "llm") {
    const prompt = buildPlannerPromptForContext(context, answers);
    const result = await runProviderPrompt({
      provider: context.profile.planner_provider,
      prompt,
      timeoutMs: options.plannerTimeoutMs,
    });
    const draft = parsePlannerDraft(result.response);
    return buildPlanFromDraft(context, answers, draft);
  }

  return buildDeterministicPlan(context, answers);
}

function buildDeterministicPlan(context: PlanContext, answers: PlanAnswers): PlanBuild {
  return {
    engine: "deterministic",
    overview: "Deterministic MVP planning flow.",
    assumptions: [],
    decisions: ["Generate three sequential task handoffs for the MVP planner flow."],
    risks: [],
    integrationNotes: [],
    tasks: buildPlannedTasks(context, answers),
  };
}

function buildPlanFromDraft(context: PlanContext, answers: PlanAnswers, draft: PlannerDraft): PlanBuild {
  validatePlannerDraftGraph(draft);

  const tasks = draft.tasks.map((task) => {
    const suggestedModel = resolveDraftModel(context, task.suggested_model, task.fit);

    return {
      id: task.id,
      title: task.title,
      filename: `${task.id.replace(/^task-/u, "")}.md`,
      suggestedModel,
      dependencies: task.dependencies,
      allowedPaths: task.allowed_paths,
      forbiddenPaths: task.forbidden_paths.length > 0 ? task.forbidden_paths : defaultForbiddenPaths(),
      riskLevel: task.risk_level,
      testCommands: task.test_commands.length > 0 ? task.test_commands : answers.validationCommands,
      objective: task.objective,
      contextRules: task.context_rules,
      executionPrompt: task.execution_prompt,
      acceptanceContract: task.acceptance_contract,
    } satisfies PlannedTask;
  });

  return {
    engine: "llm",
    overview: draft.overview,
    assumptions: draft.assumptions,
    decisions: draft.decisions,
    risks: draft.risks,
    integrationNotes: draft.integration_notes,
    tasks,
  };
}

export function parsePlannerDraft(response: string): PlannerDraft {
  const json = extractJsonObject(response);
  const parsed = PlannerDraftSchema.parse(JSON.parse(json));
  validatePlannerDraftGraph(parsed);
  return parsed;
}

function validatePlannerDraftGraph(draft: PlannerDraft): void {
  const ids = new Set<string>();

  for (const task of draft.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Planner draft contains duplicate task id ${task.id}.`);
    }

    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Planner draft task ${task.id} depends on unknown or later task ${dependency}.`);
      }
    }

    ids.add(task.id);
  }
}

function resolveDraftModel(context: PlanContext, suggestedModel: string | undefined, fit: string): ModelRegistryEntry {
  const activeModels = context.registry.filter((model) => context.profile.available_providers.includes(model.provider));

  if (suggestedModel) {
    const model = activeModels.find((candidate) => candidate.id === suggestedModel);

    if (model) {
      return model;
    }

    throw new Error(
      `Planner draft suggested unavailable model ${suggestedModel}. Active models: ${
        activeModels.map((candidate) => candidate.id).join(", ") || "none"
      }.`,
    );
  }

  return selectModel(context, fit);
}

export function buildPlannerPromptForContext(context: PlanContext, answers: PlanAnswers): string {
  const activeModels = context.registry
    .filter((model) => context.profile.available_providers.includes(model.provider))
    .map((model) => ({
      id: model.id,
      provider: model.provider,
      task_fit: model.task_fit,
      strengths: model.strengths,
      weaknesses: model.weaknesses,
      recommended_uses: model.recommended_uses,
      avoid_for: model.avoid_for,
    }));
  const payload = {
    answers,
    profile: {
      planner_provider: context.profile.planner_provider,
      planner_model: context.profile.planner_model,
      available_providers: context.profile.available_providers,
      excluded_providers: context.profile.excluded_providers,
      fallback_requires_confirmation: context.profile.routing.require_confirmation_for_fallback,
    },
    project_inventory: {
      root_name: path.basename(context.root),
      visible_file_count: context.doctor.fileCount,
      canonical_files: context.doctor.canonicalFiles,
      manifests: context.doctor.manifests,
      blocked_patterns: context.doctor.blockedPatterns,
      warnings: context.doctor.warnings,
    },
    active_models: activeModels,
  };

  return [
    "You are the planner brain for a CLI that generates AI coding handoff files.",
    "Return ONLY a JSON object. Do not use markdown fences unless unavoidable.",
    "The JSON must be directly parseable by JSON.parse.",
    "Your JSON must match this TypeScript shape:",
    `{
  "schema_version": "1.0",
  "overview": "short plan overview",
  "assumptions": ["..."],
  "decisions": ["..."],
  "risks": ["..."],
  "integration_notes": ["..."],
  "tasks": [
    {
      "id": "task-001-kebab-case",
      "title": "...",
      "objective": "...",
      "suggested_model": "one active model id",
      "fit": "planning|architecture|coding_heavy|review|refactor|tiny_edit|long_context",
      "dependencies": [],
      "allowed_paths": ["relative/path/or/glob"],
      "forbidden_paths": [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"],
      "risk_level": 1,
      "test_commands": ["..."],
      "context_rules": ["..."],
      "execution_prompt": "...",
      "acceptance_contract": ["..."]
    }
  ]
}`,
    "Rules:",
    "- Use 2 to 8 tasks.",
    "- Task ids must match task-NNN-kebab-case and dependencies may only reference earlier task ids.",
    "- suggested_model must be one of the active_models ids. Never use excluded providers.",
    "- If a task is read-only, set allowed_paths to [] and say read-only in context_rules.",
    "- If a task edits files, allowed_paths must be the narrowest relative paths or globs needed.",
    "- Prefer small, isolated handoffs with explicit allowed_paths and acceptance_contract.",
    "- Do not plan worker execution; this product only writes handoff artifacts in MVP 1.0.",
    "- Do not include secrets, token values, or ignored file contents.",
    "Example of the expected style:",
    JSON.stringify(getPlannerPromptExample(activeModels), null, 2),
    "Planning input JSON:",
    JSON.stringify(payload, null, 2),
  ].join("\n\n");
}

function getPlannerPromptExample(
  activeModels: Array<{
    id: string;
    task_fit: Record<string, number>;
  }>,
): PlannerDraft {
  const readModel = selectExampleModel(activeModels, "long_context");
  const writeModel = selectExampleModel(activeModels, "coding_heavy");

  return {
    schema_version: "1.0",
    overview: "Plan a scoped CLI feature in analysis, implementation, and validation phases.",
    assumptions: ["The active provider pool is the only routing pool."],
    decisions: ["Use a read-only context task before implementation."],
    risks: ["Generated handoffs must remain lintable."],
    integration_notes: ["Run blueprint lint after generation."],
    tasks: [
      {
        id: "task-001-map-context",
        title: "Map relevant context",
        objective: "Identify the files and contracts needed for the requested change.",
        suggested_model: readModel,
        fit: "long_context",
        dependencies: [],
        allowed_paths: [],
        forbidden_paths: defaultForbiddenPaths(),
        risk_level: 2,
        test_commands: [],
        context_rules: ["Read-only task. Do not edit files."],
        execution_prompt: "Inspect the canonical docs and manifests, then summarize the contracts needed for implementation.",
        acceptance_contract: ["No files are modified.", "Relevant files and assumptions are listed."],
      },
      {
        id: "task-002-implement-feature",
        title: "Implement scoped feature",
        objective: "Implement the requested feature within the declared paths.",
        suggested_model: writeModel,
        fit: "coding_heavy",
        dependencies: ["task-001-map-context"],
        allowed_paths: ["src/feature.ts", "tests/feature.test.ts"],
        forbidden_paths: defaultForbiddenPaths(),
        risk_level: 4,
        test_commands: ["corepack pnpm test"],
        context_rules: ["Stay inside allowed_paths.", "Do not touch secrets or generated folders."],
        execution_prompt: "Implement the feature, add focused tests, and report any blocker with the exact failing command.",
        acceptance_contract: ["Feature behavior is implemented.", "Focused tests pass."],
      },
    ],
  };
}

function selectExampleModel(activeModels: Array<{ id: string; task_fit: Record<string, number> }>, fit: string): string {
  const sorted = [...activeModels].sort((left, right) => (right.task_fit[fit] ?? 0) - (left.task_fit[fit] ?? 0));
  const selected = sorted[0] ?? activeModels[0];

  if (!selected) {
    return "active-model-id";
  }

  return selected.id;
}

function buildPlannedTasks(context: PlanContext, answers: PlanAnswers): PlannedTask[] {
  const implementationPaths = answers.targetPaths.length > 0 ? answers.targetPaths : ["src/**", "tests/**", "docs/**"];
  const validationPaths = uniqueStrings([
    ...implementationPaths.filter((targetPath) => /test|spec|docs|package\.json|pnpm-lock\.yaml/u.test(targetPath)),
    "tests/**",
    "docs/**",
    "package.json",
  ]);
  const forbiddenPaths = defaultForbiddenPaths();

  return [
    {
      id: "task-001-context-map",
      title: "Map current context and contracts",
      filename: "001-context-map.md",
      suggestedModel: selectModel(context, "long_context"),
      dependencies: [],
      allowedPaths: [],
      forbiddenPaths,
      riskLevel: clampRisk(answers.riskLevel - 2),
      testCommands: [],
      objective: "Inspect the project context and return a concise implementation map before any file edits.",
      contextRules: [
        "This is a read-only task. Do not edit files.",
        `Use only visible project context under ${context.root}.`,
        `Canonical docs detected: ${context.doctor.canonicalFiles.join(", ") || "none"}.`,
        `Respect blocked patterns: ${context.doctor.blockedPatterns.join(", ")}.`,
      ],
      executionPrompt: [
        `Project summary: ${answers.projectSummary}`,
        `Target objective: ${answers.objective}`,
        "Read the canonical docs and manifests that are relevant to the objective.",
        "Return the files, contracts, risks, and likely implementation order the next worker should know.",
      ].join("\n\n"),
      acceptanceContract: [
        "No files are modified.",
        "Output names the concrete files or modules the implementation worker should inspect first.",
        "Output lists assumptions and blockers separately.",
      ],
    },
    {
      id: "task-002-implement-core-work",
      title: "Implement the core project change",
      filename: "002-implement-core-work.md",
      suggestedModel: selectModel(context, "coding_heavy"),
      dependencies: ["task-001-context-map"],
      allowedPaths: implementationPaths,
      forbiddenPaths,
      riskLevel: answers.riskLevel,
      testCommands: answers.validationCommands,
      objective: answers.objective,
      contextRules: [
        `Allowed write paths: ${implementationPaths.join(", ")}.`,
        `Forbidden paths: ${forbiddenPaths.join(", ")}.`,
        `Must satisfy: ${answers.successCriteria.join("; ")}.`,
        `Out of scope: ${answers.outOfScope.join("; ") || "none declared"}.`,
      ],
      executionPrompt: [
        `Implement this objective: ${answers.objective}`,
        `Project summary: ${answers.projectSummary}`,
        `Success criteria:\n${formatMarkdownList(answers.successCriteria)}`,
        `Constraints:\n${formatMarkdownList(answers.constraints)}`,
        `Notes:\n${formatMarkdownList(answers.notes)}`,
        "Keep changes scoped to the allowed paths. Do not rewrite unrelated code.",
      ].join("\n\n"),
      acceptanceContract: [
        ...answers.successCriteria,
        "Implementation stays within allowed paths unless the user explicitly approves an expansion.",
        "Any unresolved blocker is reported with the exact missing file, command, or decision.",
      ],
    },
    {
      id: "task-003-integrate-and-validate",
      title: "Integrate results and validate acceptance",
      filename: "003-integrate-and-validate.md",
      suggestedModel: selectModel(context, "review"),
      dependencies: ["task-002-implement-core-work"],
      allowedPaths: validationPaths,
      forbiddenPaths,
      riskLevel: clampRisk(answers.riskLevel - 1),
      testCommands: answers.validationCommands,
      objective: "Review the implemented work, run validation, and prepare final integration notes.",
      contextRules: [
        `Validation commands: ${answers.validationCommands.join(" && ") || "manual verification required"}.`,
        `Allowed write paths for fixes/docs: ${validationPaths.join(", ")}.`,
        "Do not expand implementation scope. Only fix issues needed to satisfy acceptance.",
      ],
      executionPrompt: [
        "Review the implementation against the original objective and success criteria.",
        `Objective: ${answers.objective}`,
        `Success criteria:\n${formatMarkdownList(answers.successCriteria)}`,
        `Run or explain these validation commands:\n${formatMarkdownList(answers.validationCommands)}`,
        "If validation cannot run, report the exact blocker and the command that failed or was skipped.",
      ].join("\n\n"),
      acceptanceContract: [
        "All declared validation commands pass, or exact blockers are documented.",
        "Final notes summarize changed behavior, tests run, and residual risks.",
        "No unrelated refactors are introduced.",
      ],
    },
  ];
}

function buildDependencyGraph(tasks: PlannedTask[]): DependencyGraph {
  return {
    schema_version: "1.0",
    nodes: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      task_file: `tasks/${task.filename}`,
      depends_on: task.dependencies,
      allowed_paths: task.allowedPaths,
      risk_level: task.riskLevel,
    })),
    edges: tasks.flatMap((task) =>
      task.dependencies.map((dependency) => ({
        from: dependency,
        to: task.id,
        reason: `${task.title} requires ${dependency} to be complete.`,
      })),
    ),
    parallel_groups: {},
  };
}

function renderArchitecture(context: PlanContext, answers: PlanAnswers, plan: PlanBuild): string {
  return `${frontMatterComment()}
# Architecture

## Project

${answers.projectSummary}

## Objective

${answers.objective}

## Planner Source

- Engine: ${plan.engine}
- Overview: ${plan.overview}

## Active Planner Profile

- Planner provider: ${context.profile.planner_provider}
- Planner model: ${context.profile.planner_model}
- Available providers: ${context.profile.available_providers.join(", ")}
- Excluded providers: ${context.profile.excluded_providers.join(", ") || "none"}

## Context Inventory

- Project root: ${context.root}
- Visible files: ${context.doctor.fileCount}
- Canonical files: ${context.doctor.canonicalFiles.join(", ") || "none"}
- Manifests: ${context.doctor.manifests.join(", ") || "none"}
- Blocked patterns: ${context.doctor.blockedPatterns.join(", ")}

## Work Breakdown

${plan.tasks.map((task) => `- ${task.id}: ${task.title} (${task.suggestedModel.id})`).join("\n")}

## Constraints

${formatMarkdownList(answers.constraints)}

## Out Of Scope

${formatMarkdownList(answers.outOfScope)}
`;
}

function renderAssumptions(context: PlanContext, answers: PlanAnswers, plan: PlanBuild): string {
  return `${frontMatterComment()}
# Assumptions

${formatMarkdownList([
    "The active profile is the source of truth for provider availability.",
    "Workers must not use providers outside available_providers unless the user approves fallback.",
    "Secrets and ignored/generated folders remain blocked by default.",
    ...answers.notes,
    ...context.doctor.warnings,
    ...plan.assumptions,
  ])}
`;
}

function renderDecisions(context: PlanContext, answers: PlanAnswers, plan: PlanBuild): string {
  return `${frontMatterComment()}
# Decisions

${formatMarkdownList([
    `Use ${context.profile.planner_model} as planner model for this plan.`,
    `Restrict model routing to ${context.profile.available_providers.join(", ")}.`,
    `Generate task handoffs using ${plan.engine} planning.`,
    ...plan.tasks.map((task) => `Assign ${task.id} to ${task.suggestedModel.id}.`),
    ...answers.constraints.map((constraint) => `Respect constraint: ${constraint}`),
    ...plan.decisions,
  ])}
`;
}

function renderRisks(context: PlanContext, answers: PlanAnswers, plan: PlanBuild): string {
  return `${frontMatterComment()}
# Risks

${formatMarkdownList([
    `Overall risk level: ${answers.riskLevel}/10.`,
    ...context.doctor.warnings,
    ...answers.constraints.map((constraint) => `Constraint may affect delivery: ${constraint}`),
    ...(answers.validationCommands.length === 0
      ? ["No validation commands were declared; acceptance depends on manual review."]
      : []),
    ...(context.profile.excluded_providers.includes("anthropic")
      ? ["Anthropic/Claude is excluded from the active pool for this plan."]
      : []),
    ...plan.risks,
  ])}
`;
}

function renderIntegrationGuide(context: PlanContext, answers: PlanAnswers, plan: PlanBuild): string {
  return `${frontMatterComment()}
# Integration Guide

## Execution Order

${plan.tasks.map((task, index) => `${index + 1}. ${task.id} - ${task.title}`).join("\n")}

## Validation

${formatMarkdownList(answers.validationCommands)}

## Provider Rules

- Active providers: ${context.profile.available_providers.join(", ")}
- Excluded providers: ${context.profile.excluded_providers.join(", ") || "none"}
- Fallback requires confirmation: ${context.profile.routing.require_confirmation_for_fallback ? "yes" : "no"}

## Acceptance

${formatMarkdownList(answers.successCriteria)}

## Planner Notes

${formatMarkdownList(plan.integrationNotes)}
`;
}

function renderTasksReadme(tasks: PlannedTask[]): string {
  return `${frontMatterComment()}
# Tasks

${tasks.map((task) => `- ${task.id}: ${task.filename}`).join("\n")}
`;
}

function renderTask(task: PlannedTask): string {
  const metadata: BlueprintTaskMetadata = {
    id: task.id,
    title: task.title,
    suggested_model: task.suggestedModel.id,
    dependencies: task.dependencies,
    allowed_paths: task.allowedPaths,
    forbidden_paths: task.forbiddenPaths,
    risk_level: task.riskLevel,
    test_commands: task.testCommands,
  };

  return `---\n${stringify(metadata)}---\n\n<task_objective>\n${escapeXmlText(task.objective)}\n</task_objective>\n\n<suggested_model>\n${escapeXmlText(`${task.suggestedModel.id} (${task.suggestedModel.provider})`)}\n</suggested_model>\n\n<context_rules>\n${escapeXmlText(formatMarkdownList(task.contextRules))}\n</context_rules>\n\n<execution_prompt>\n${escapeXmlText(task.executionPrompt)}\n</execution_prompt>\n\n<acceptance_contract>\n${escapeXmlText(formatMarkdownList(task.acceptanceContract))}\n</acceptance_contract>\n`;
}

function selectModel(context: PlanContext, fit: string): ModelRegistryEntry {
  const activeModels = context.registry.filter((model) => context.profile.available_providers.includes(model.provider));
  const plannerModel = activeModels.find((model) => model.id === context.profile.planner_model);
  const sorted = [...activeModels].sort((left, right) => (right.task_fit[fit] ?? 0) - (left.task_fit[fit] ?? 0));

  return sorted[0] ?? plannerModel ?? context.registry[0]!;
}

function inferValidationCommands(report: ProjectDoctorReport): string[] {
  if (report.manifests.includes("package.json")) {
    return ["corepack pnpm typecheck", "corepack pnpm test"];
  }

  if (report.manifests.includes("pyproject.toml")) {
    return ["pytest"];
  }

  if (report.manifests.includes("Cargo.toml")) {
    return ["cargo test"];
  }

  if (report.manifests.includes("go.mod")) {
    return ["go test ./..."];
  }

  return [];
}

async function promptText(message: string): Promise<string> {
  const answer = await text({
    message,
    validate: (value) => (!value?.trim() ? "Required." : undefined),
  });

  if (isCancel(answer)) {
    cancel("Planning cancelled.");
    process.exit(0);
  }

  return answer.trim();
}

async function promptList(
  message: string,
  options: { optional?: boolean; defaultValue?: string } = {},
): Promise<string[]> {
  const answer = await multiline({
    message,
    defaultValue: options.defaultValue,
    showSubmit: true,
    validate: (value) => {
      if (options.optional) {
        return undefined;
      }

      return parseList(value ?? "").length === 0 ? "At least one item is required." : undefined;
    },
  });

  if (isCancel(answer)) {
    cancel("Planning cancelled.");
    process.exit(0);
  }

  return parseList(answer);
}

function parseList(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim().replace(/^[-*]\s+/u, ""))
    .filter(Boolean);
}

function formatMarkdownList(items: string[]): string {
  if (items.length === 0) {
    return "- none declared";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultForbiddenPaths(): string[] {
  return [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"];
}

function clampRisk(value: number): number {
  return Math.max(1, Math.min(10, value));
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function frontMatterComment(): string {
  return "<!-- Generated by blueprint plan. Edit carefully or rerun blueprint plan --force. -->\n";
}
