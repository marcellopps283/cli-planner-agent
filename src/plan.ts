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
import { runLlmPlannerEngine, type PlannerPromptRunner } from "./plannerEngine.js";
import { activeModelsForProfile, loadPlannerProfile } from "./profile.js";
import { extractJsonObject } from "./providerPrompt.js";
import { loadModelRegistryForProfile } from "./registry.js";
import {
  type BlueprintManifest,
  type BlueprintTaskMetadata,
  type DependencyGraph,
  type ModelRegistryEntry,
  type PlannerProfile,
  type ProviderId,
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
  model_rationale: z.string().min(1).optional(),
  acceptable_alternatives: z.array(z.string().min(1)).default([]),
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
  plannerProvider?: ProviderId;
  plannerModel?: string;
  plannerPromptRunner?: PlannerPromptRunner;
  repairAttempts?: number;
  draft?: PlannerDraft;
  force?: boolean;
}

export interface GeneratePlanResult {
  root: string;
  files: string[];
  taskIds: string[];
  engine: PlanEngine;
}

export interface PlanPreviewTask {
  id: string;
  title: string;
  suggestedModel: string;
  modelRationale: string;
  acceptableAlternatives: string[];
  dependencies: string[];
  allowedPaths: string[];
  riskLevel: number;
}

export interface PlanPreviewResult {
  root: string;
  engine: PlanEngine;
  plannerProvider: ProviderId;
  plannerModel: string;
  plannerFallback: boolean;
  overview: string;
  tasks: PlanPreviewTask[];
}

export interface PlanContext {
  root: string;
  profile: PlannerProfile;
  registry: ModelRegistryEntry[];
  doctor: ProjectDoctorReport;
}

export interface PlannerFallbackCandidate {
  provider: ProviderId;
  model: string;
  planningScore: number;
  reason: string;
}

export interface PlannerFallbackLookupOptions {
  root: string;
  failedModel?: string;
}

interface PlannedTask {
  id: string;
  title: string;
  filename: string;
  suggestedModel: ModelRegistryEntry;
  modelRationale: string;
  acceptableAlternatives: string[];
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
  plannerProvider: ProviderId;
  plannerModel: string;
  plannerFallback: boolean;
  plannerAttempts: number;
  overview: string;
  assumptions: string[];
  decisions: string[];
  risks: string[];
  integrationNotes: string[];
  tasks: PlannedTask[];
}

interface PreparedPlan {
  root: string;
  context: PlanContext;
  answers: PlanAnswers;
  plan: PlanBuild;
  blueprintRoot: string;
}

export async function runPlanCommand(options: PlanCommandOptions): Promise<void> {
  const root = path.resolve(options.root);
  const context = await loadPlanContext(root);
  const answers = options.answersPath ? await readAnswersFile(options.answersPath) : await collectPlanAnswers(context);

  if (!options.yes && !options.answersPath) {
    const approved = await confirmPlanStart(context, answers);

    if (!approved) {
      cancel("Planning cancelled.");
      return;
    }
  }

  const engine = options.engine ?? "deterministic";
  let result: GeneratePlanResult | undefined;

  try {
    const prepared = await prepareBlueprintPlan({
      root,
      answers,
      engine,
      plannerTimeoutMs: options.plannerTimeoutMs,
      force: options.force ?? options.yes ?? Boolean(options.answersPath),
    });

    if (!options.yes && !options.answersPath) {
      const approved = await confirmPlanAssignments(prepared);

      if (!approved) {
        cancel("Planning cancelled.");
        return;
      }
    }

    result = await writePreparedPlan(prepared, {
      force: options.force ?? options.yes ?? Boolean(options.answersPath),
    });
  } catch (error) {
    if (engine !== "llm" || !options.fallback || isNonPlannerFallbackError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    log.warn(`LLM planner failed: ${message}`);
    const fallbackCandidate = getPlannerFallbackCandidates(context)[0];

    if (fallbackCandidate) {
      if (!options.yes) {
        const approved = await confirm({
          message: `Tentar fallback LLM com ${fallbackCandidate.provider}/${fallbackCandidate.model}?`,
          initialValue: true,
        });

        if (isCancel(approved) || !approved) {
          cancel("Planning cancelled.");
          return;
        }
      }

      try {
        const prepared = await prepareBlueprintPlan({
          root,
          answers,
          engine: "llm",
          plannerProvider: fallbackCandidate.provider,
          plannerModel: fallbackCandidate.model,
          plannerTimeoutMs: options.plannerTimeoutMs,
          force: true,
        });

        if (!options.yes && !options.answersPath) {
          const approved = await confirmPlanAssignments(prepared);

          if (!approved) {
            cancel("Planning cancelled.");
            return;
          }
        }

        result = await writePreparedPlan(prepared, { force: true });
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        log.warn(`LLM fallback failed: ${fallbackMessage}`);
      }
    }

    if (!result) {
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

      const prepared = await prepareBlueprintPlan({
        root,
        answers,
        engine: "deterministic",
        force: true,
      });

      if (!options.yes && !options.answersPath) {
        const approved = await confirmPlanAssignments(prepared);

        if (!approved) {
          cancel("Planning cancelled.");
          return;
        }
      }

      result = await writePreparedPlan(prepared, { force: true });
    }
  }
  if (!result) {
    throw new Error("Planning finished without generated artifacts.");
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
  const prepared = await prepareBlueprintPlan(options);
  return writePreparedPlan(prepared, { force: options.force });
}

export async function previewBlueprintPlan(options: GeneratePlanOptions): Promise<PlanPreviewResult> {
  const prepared = await prepareBlueprintPlan(options);

  return {
    root: prepared.root,
    engine: prepared.plan.engine,
    plannerProvider: prepared.plan.plannerProvider,
    plannerModel: prepared.plan.plannerModel,
    plannerFallback: prepared.plan.plannerFallback,
    overview: prepared.plan.overview,
    tasks: prepared.plan.tasks.map(toPreviewTask),
  };
}

async function prepareBlueprintPlan(options: GeneratePlanOptions): Promise<PreparedPlan> {
  const root = path.resolve(options.root);
  const context = await loadPlanContext(root);
  const answers = PlanAnswersSchema.parse(options.answers);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);

  if (!options.force) {
    await assertPlanCanBeWritten(blueprintRoot);
  }

  const plan = await buildPlan(context, answers, options);

  return {
    root,
    context,
    answers,
    plan,
    blueprintRoot,
  };
}

async function writePreparedPlan(
  prepared: PreparedPlan,
  options: { force?: boolean },
): Promise<GeneratePlanResult> {
  const { root, context, answers, blueprintRoot, plan } = prepared;

  await mkdir(path.join(blueprintRoot, "tasks"), { recursive: true });

  if (options.force) {
    await clearExistingTaskFiles(blueprintRoot);
  }

  const tasks = plan.tasks;
  const manifest: BlueprintManifest = {
    schema_version: "1.0",
    project_name: path.basename(root),
    created_at: new Date().toISOString(),
    planner_provider: plan.plannerProvider,
    planner_model: plan.plannerModel,
    available_providers: context.profile.available_providers,
    available_models: activeModelsForProfile(context.profile, context.registry).map((model) => model.id),
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

function toPreviewTask(task: PlannedTask): PlanPreviewTask {
  return {
    id: task.id,
    title: task.title,
    suggestedModel: task.suggestedModel.id,
    modelRationale: task.modelRationale,
    acceptableAlternatives: task.acceptableAlternatives,
    dependencies: task.dependencies,
    allowedPaths: task.allowedPaths,
    riskLevel: task.riskLevel,
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

export async function getPlannerFallbackCandidatesForRoot(
  options: PlannerFallbackLookupOptions,
): Promise<PlannerFallbackCandidate[]> {
  const context = await loadPlanContext(path.resolve(options.root));
  return getPlannerFallbackCandidates(context, options.failedModel);
}

async function collectPlanAnswers(context: PlanContext): Promise<PlanAnswers> {
  intro("blueprint plan");
  note(
    [
      `planner: ${context.profile.planner_provider} / ${context.profile.planner_model}`,
      `providers: ${context.profile.available_providers.join(", ")}`,
      `models: ${activeModelsForProfile(context.profile, context.registry).map((model) => model.id).join(", ")}`,
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

async function confirmPlanStart(context: PlanContext, answers: PlanAnswers): Promise<boolean> {
  note(
    [
      `objective: ${answers.objective}`,
      "next: planner will build a task graph preview",
      `planner: ${context.profile.planner_model}`,
      `active models: ${activeModelsForProfile(context.profile, context.registry).map((model) => model.id).join(", ")}`,
      `validation: ${answers.validationCommands.join(" && ") || "manual acceptance only"}`,
    ].join("\n"),
    "Executive Summary",
  );

  const approved = await confirm({
    message: "Rodar o planner e montar o preview de tarefas?",
    initialValue: true,
  });

  if (isCancel(approved)) {
    return false;
  }

  return approved;
}

async function confirmPlanAssignments(prepared: PreparedPlan): Promise<boolean> {
  const preview = prepared.plan.tasks.map(toPreviewTask);

  note(
    [
      `overview: ${prepared.plan.overview}`,
      `engine: ${prepared.plan.engine}`,
      `tasks: ${preview.length}`,
      ...preview.map((task) => {
        const deps = task.dependencies.length > 0 ? task.dependencies.join(",") : "none";
        const paths = task.allowedPaths.length > 0 ? task.allowedPaths.join(",") : "read-only";
        return `${task.id}: ${task.suggestedModel} | risk ${task.riskLevel} | deps ${deps} | paths ${paths}`;
      }),
    ].join("\n"),
    "Task Graph & Model Assignments",
  );

  const approved = await confirm({
    message: "Aprovar estas atribuicoes e escrever os handoffs em .blueprint/?",
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
    return buildPlanFromDraft(context, answers, options.draft, {
      plannerProvider: options.plannerProvider,
      plannerModel: options.plannerModel,
      plannerFallback: Boolean(options.plannerModel && options.plannerModel !== context.profile.planner_model),
      plannerAttempts: 0,
    });
  }

  if (options.engine === "llm") {
    const plannerModel = resolvePlannerExecutionModel(context, options);
    const prompt = buildPlannerPromptForContext(context, answers);
    const result = await runLlmPlannerEngine({
      provider: plannerModel.provider,
      model: plannerModel.id,
      prompt,
      parseDraft: parsePlannerDraft,
      runner: options.plannerPromptRunner,
      timeoutMs: options.plannerTimeoutMs,
      repairAttempts: options.repairAttempts,
    });

    return buildPlanFromDraft(context, answers, result.draft, {
      plannerProvider: result.provider,
      plannerModel: result.model,
      plannerFallback: result.model !== context.profile.planner_model,
      plannerAttempts: result.attempts.length,
    });
  }

  return buildDeterministicPlan(context, answers);
}

function buildDeterministicPlan(context: PlanContext, answers: PlanAnswers): PlanBuild {
  return {
    engine: "deterministic",
    plannerProvider: context.profile.planner_provider,
    plannerModel: context.profile.planner_model,
    plannerFallback: false,
    plannerAttempts: 0,
    overview: "Deterministic MVP planning flow.",
    assumptions: [],
    decisions: ["Generate three sequential task handoffs for the MVP planner flow."],
    risks: [],
    integrationNotes: [],
    tasks: buildPlannedTasks(context, answers),
  };
}

function buildPlanFromDraft(
  context: PlanContext,
  answers: PlanAnswers,
  draft: PlannerDraft,
  plannerRun?: {
    plannerProvider?: ProviderId;
    plannerModel?: string;
    plannerFallback?: boolean;
    plannerAttempts?: number;
  },
): PlanBuild {
  validatePlannerDraftGraph(draft);
  const plannerModel = resolvePlannerExecutionModel(context, {
    root: context.root,
    answers,
    engine: "llm",
    plannerProvider: plannerRun?.plannerProvider,
    plannerModel: plannerRun?.plannerModel,
    force: true,
  });

  const tasks = draft.tasks.map((task) => {
    const suggestedModel = resolveDraftModel(context, task.suggested_model, task.fit);
    const acceptableAlternatives = resolveDraftAlternatives(
      context,
      task.acceptable_alternatives,
      suggestedModel,
      task.fit,
    );

    return {
      id: task.id,
      title: task.title,
      filename: `${task.id.replace(/^task-/u, "")}.md`,
      suggestedModel,
      modelRationale:
        task.model_rationale ?? defaultModelRationale(suggestedModel, task.fit, task.risk_level),
      acceptableAlternatives,
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
    plannerProvider: plannerModel.provider,
    plannerModel: plannerModel.id,
    plannerFallback: plannerRun?.plannerFallback ?? plannerModel.id !== context.profile.planner_model,
    plannerAttempts: plannerRun?.plannerAttempts ?? 0,
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
  const activeModels = activeModelsForProfile(context.profile, context.registry);

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

function resolveDraftAlternatives(
  context: PlanContext,
  alternatives: string[],
  selectedModel: ModelRegistryEntry,
  fit: string,
): string[] {
  if (alternatives.length === 0) {
    return defaultModelAlternatives(context, selectedModel, fit);
  }

  const activeModelIds = new Set(activeModelsForProfile(context.profile, context.registry).map((model) => model.id));
  const resolved: string[] = [];

  for (const alternative of alternatives) {
    if (!activeModelIds.has(alternative)) {
      throw new Error(
        `Planner draft suggested unavailable alternative model ${alternative}. Active models: ${
          [...activeModelIds].join(", ") || "none"
        }.`,
      );
    }

    if (alternative !== selectedModel.id) {
      resolved.push(alternative);
    }
  }

  return uniqueStrings(resolved).slice(0, 3);
}

function defaultModelRationale(model: ModelRegistryEntry, fit: string, riskLevel: number): string {
  return [
    `Selected ${model.id} for ${fit}.`,
    `fit=${formatScore(model.task_fit[fit])}`,
    `tier=${model.tier}`,
    `risk=${riskLevel}`,
    `latency=${model.latency_class}`,
    `cost=${model.cost_class}`,
  ].join(" ");
}

function defaultModelAlternatives(
  context: PlanContext,
  selectedModel: ModelRegistryEntry,
  fit: string,
): string[] {
  return activeModelsForProfile(context.profile, context.registry)
    .filter((model) => model.id !== selectedModel.id && model.status !== "restricted")
    .sort((left, right) => (right.task_fit[fit] ?? 0) - (left.task_fit[fit] ?? 0))
    .slice(0, 2)
    .map((model) => model.id);
}

function resolvePlannerExecutionModel(context: PlanContext, options: GeneratePlanOptions): ModelRegistryEntry {
  const activeModels = activeModelsForProfile(context.profile, context.registry);
  const requestedModelId = options.plannerModel ?? context.profile.planner_model;
  const requestedProvider = options.plannerProvider ?? context.profile.planner_provider;
  const model = activeModels.find((candidate) => candidate.id === requestedModelId);

  if (!model) {
    throw new Error(
      `Planner model ${requestedModelId} is not in the active model pool: ${
        activeModels.map((candidate) => candidate.id).join(", ") || "none"
      }.`,
    );
  }

  if (model.provider !== requestedProvider) {
    throw new Error(`Planner model ${model.id} belongs to ${model.provider}, not ${requestedProvider}.`);
  }

  if (!context.profile.available_providers.includes(model.provider)) {
    throw new Error(`Planner provider ${model.provider} is not available in the active profile.`);
  }

  return model;
}

function isNonPlannerFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /Existing task files found|Profile is not ready|Model registry is not ready/u.test(message);
}

export function getPlannerFallbackCandidates(
  context: PlanContext,
  failedModel = context.profile.planner_model,
): PlannerFallbackCandidate[] {
  if (!context.profile.routing.allow_provider_fallback) {
    return [];
  }

  const activeModels = activeModelsForProfile(context.profile, context.registry);

  return activeModels
    .filter((model) => model.id !== failedModel && model.status !== "restricted")
    .sort(comparePlannerFallbackModels)
    .map((model) => ({
      provider: model.provider,
      model: model.id,
      planningScore: model.task_fit.planning ?? 0,
      reason: [
        `planning=${formatScore(model.task_fit.planning)}`,
        `tier=${model.tier}`,
        `latency=${model.latency_class}`,
        `cost=${model.cost_class}`,
      ].join(" "),
    }));
}

export function buildPlannerPromptForContext(context: PlanContext, answers: PlanAnswers): string {
  const activeModels = activeModelsForProfile(context.profile, context.registry).map((model) => ({
    id: model.id,
    provider: model.provider,
    status: model.status,
    tier: model.tier,
    task_fit: model.task_fit,
    context_window: model.context_window,
    max_output_tokens: model.max_output_tokens,
    input_price_usd_per_mtok: model.input_price_usd_per_mtok,
    output_price_usd_per_mtok: model.output_price_usd_per_mtok,
    latency_class: model.latency_class,
    cost_class: model.cost_class,
    routing_tags: model.routing_tags,
    benchmark_scores: model.benchmark_scores,
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
      available_models: context.profile.available_models,
      excluded_providers: context.profile.excluded_providers,
      fallback_requires_confirmation: context.profile.routing.require_confirmation_for_fallback,
    },
    project_inventory: {
      root_name: path.basename(context.root),
      visible_file_count: context.doctor.fileCount,
      stack: context.doctor.stack,
      canonical_files: context.doctor.canonicalFiles,
      manifests: context.doctor.manifests,
      scripts: context.doctor.scripts,
      top_level_dirs: context.doctor.topLevelDirs,
      inventory_files: context.doctor.inventoryFiles,
      markdown_headings: context.doctor.markdownHeadings,
      blocked_patterns: context.doctor.blockedPatterns,
      warnings: context.doctor.warnings,
    },
    active_models: activeModels,
  };

  return [
    "You are the planner brain for a CLI that generates AI coding handoff files.",
    "Route work by exact model id, not by provider name or generic aliases.",
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
      "model_rationale": "short reason using fit, risk, context, cost, latency, benchmarks, or provider availability",
      "acceptable_alternatives": ["other active model id"],
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
    "- suggested_model must be one of the active_models ids. Never use excluded providers or generic provider defaults.",
    "- model_rationale must explain why the exact suggested_model fits this task better than smaller or excluded options.",
    "- acceptable_alternatives may contain up to 3 active model ids that can execute the same task if the primary model is unavailable.",
    "- Prefer the smallest active model that clears the task risk, context, and benchmark needs.",
    "- Use benchmark_scores, routing_tags, task_fit, context_window, latency_class, and prices when choosing a model.",
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
        model_rationale: "Best active long_context fit for read-only context mapping with low edit risk.",
        acceptable_alternatives: getExampleAlternatives(activeModels, readModel, "long_context"),
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
        model_rationale: "Best active coding_heavy fit for implementation risk and test-oriented changes.",
        acceptable_alternatives: getExampleAlternatives(activeModels, writeModel, "coding_heavy"),
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

function getExampleAlternatives(
  activeModels: Array<{ id: string; task_fit: Record<string, number> }>,
  selectedModel: string,
  fit: string,
): string[] {
  return [...activeModels]
    .filter((model) => model.id !== selectedModel)
    .sort((left, right) => (right.task_fit[fit] ?? 0) - (left.task_fit[fit] ?? 0))
    .slice(0, 2)
    .map((model) => model.id);
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
      modelRationale: defaultModelRationale(selectModel(context, "long_context"), "long_context", clampRisk(answers.riskLevel - 2)),
      acceptableAlternatives: defaultModelAlternatives(context, selectModel(context, "long_context"), "long_context"),
      dependencies: [],
      allowedPaths: [],
      forbiddenPaths,
      riskLevel: clampRisk(answers.riskLevel - 2),
      testCommands: [],
      objective: "Inspect the project context and return a concise implementation map before any file edits.",
      contextRules: [
        "This is a read-only task. Do not edit files.",
        `Use only visible project context under ${context.root}.`,
        `Detected stack: ${context.doctor.stack.join(", ") || "unknown"}.`,
        `Canonical docs detected: ${context.doctor.canonicalFiles.join(", ") || "none"}.`,
        `Top-level dirs detected: ${context.doctor.topLevelDirs.join(", ") || "none"}.`,
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
      modelRationale: defaultModelRationale(selectModel(context, "coding_heavy"), "coding_heavy", answers.riskLevel),
      acceptableAlternatives: defaultModelAlternatives(context, selectModel(context, "coding_heavy"), "coding_heavy"),
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
      modelRationale: defaultModelRationale(selectModel(context, "review"), "review", clampRisk(answers.riskLevel - 1)),
      acceptableAlternatives: defaultModelAlternatives(context, selectModel(context, "review"), "review"),
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
- Planner provider: ${plan.plannerProvider}
- Planner model: ${plan.plannerModel}
- Planner fallback: ${plan.plannerFallback ? "yes" : "no"}
- Planner attempts: ${plan.plannerAttempts}
- Overview: ${plan.overview}

## Active Planner Profile

- Planner provider: ${context.profile.planner_provider}
- Planner model: ${context.profile.planner_model}
- Available providers: ${context.profile.available_providers.join(", ")}
- Active model pool: ${activeModelsForProfile(context.profile, context.registry)
    .map((model) => model.id)
    .join(", ")}
- Excluded providers: ${context.profile.excluded_providers.join(", ") || "none"}

## Context Inventory

- Project root: ${context.root}
- Visible files: ${context.doctor.fileCount}
- Detected stack: ${context.doctor.stack.join(", ") || "unknown"}
- Canonical files: ${context.doctor.canonicalFiles.join(", ") || "none"}
- Manifests: ${context.doctor.manifests.join(", ") || "none"}
- Scripts: ${Object.keys(context.doctor.scripts).join(", ") || "none"}
- Top-level dirs: ${context.doctor.topLevelDirs.join(", ") || "none"}
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
    "Workers must use exact IDs from available_models unless the user approves fallback.",
    "Providers remain authentication boundaries; models are the routing unit.",
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
    `Use ${plan.plannerModel} as planner model for this plan.`,
    `Restrict model routing to ${activeModelsForProfile(context.profile, context.registry)
      .map((model) => model.id)
      .join(", ")}.`,
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
- Active models: ${activeModelsForProfile(context.profile, context.registry)
    .map((model) => model.id)
    .join(", ")}
- Planner used: ${plan.plannerProvider}/${plan.plannerModel}
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
    model_rationale: task.modelRationale,
    acceptable_alternatives: task.acceptableAlternatives,
    dependencies: task.dependencies,
    allowed_paths: task.allowedPaths,
    forbidden_paths: task.forbiddenPaths,
    risk_level: task.riskLevel,
    test_commands: task.testCommands,
  };

  return `---\n${stringify(metadata)}---\n\n<task_objective>\n${escapeXmlText(task.objective)}\n</task_objective>\n\n<suggested_model>\n${escapeXmlText(`${task.suggestedModel.id} (${task.suggestedModel.provider})`)}\n</suggested_model>\n\n<model_rationale>\n${escapeXmlText(task.modelRationale)}\n\nAcceptable alternatives: ${escapeXmlText(task.acceptableAlternatives.join(", ") || "none")}\n</model_rationale>\n\n<context_rules>\n${escapeXmlText(formatMarkdownList(task.contextRules))}\n</context_rules>\n\n<execution_prompt>\n${escapeXmlText(task.executionPrompt)}\n</execution_prompt>\n\n<acceptance_contract>\n${escapeXmlText(formatMarkdownList(task.acceptanceContract))}\n</acceptance_contract>\n`;
}

function selectModel(context: PlanContext, fit: string): ModelRegistryEntry {
  const activeModels = activeModelsForProfile(context.profile, context.registry);
  const plannerModel = activeModels.find((model) => model.id === context.profile.planner_model);
  const sorted = [...activeModels].sort((left, right) => (right.task_fit[fit] ?? 0) - (left.task_fit[fit] ?? 0));

  return sorted[0] ?? plannerModel ?? context.registry[0]!;
}

function comparePlannerFallbackModels(left: ModelRegistryEntry, right: ModelRegistryEntry): number {
  const planningDiff = (right.task_fit.planning ?? 0) - (left.task_fit.planning ?? 0);

  if (planningDiff !== 0) {
    return planningDiff;
  }

  const tierDiff = modelTierWeight(right.tier) - modelTierWeight(left.tier);

  if (tierDiff !== 0) {
    return tierDiff;
  }

  const latencyDiff = latencyWeight(right.latency_class) - latencyWeight(left.latency_class);

  if (latencyDiff !== 0) {
    return latencyDiff;
  }

  return left.id.localeCompare(right.id);
}

function modelTierWeight(tier: ModelRegistryEntry["tier"]): number {
  if (tier === "frontier") {
    return 4;
  }

  if (tier === "balanced") {
    return 3;
  }

  if (tier === "utility") {
    return 2;
  }

  return 1;
}

function latencyWeight(latency: ModelRegistryEntry["latency_class"]): number {
  if (latency === "low") {
    return 3;
  }

  if (latency === "medium") {
    return 2;
  }

  if (latency === "high") {
    return 1;
  }

  return 0;
}

function formatScore(score: number | undefined): string {
  return typeof score === "number" ? score.toFixed(2) : "n/a";
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
