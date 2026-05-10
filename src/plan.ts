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

export function parsePlanAnswers(value: unknown): PlanAnswers {
  const answers = PlanAnswersSchema.parse(value);

  return {
    ...answers,
    validationCommands: normalizeValidationCommands(answers.validationCommands),
  };
}

export function normalizeValidationCommands(commands: string[]): string[] {
  const normalized = commands
    .map((command) => normalizeValidationCommand(command))
    .filter((command) => command.length > 0);

  return uniqueStrings(normalized);
}

function normalizeValidationCommand(command: string): string {
  const collapsed = command.trim().replace(/\s+/gu, " ");

  if (collapsed.length === 0) {
    return "";
  }

  const pnpmTestRun = /^(?:corepack\s+)?pnpm\s+test\s+run(?:\s+(.+))?$/u.exec(collapsed);

  if (pnpmTestRun) {
    return `corepack pnpm test${pnpmTestRun[1] ? ` ${pnpmTestRun[1]}` : ""}`;
  }

  if (/^pnpm\s+/u.test(collapsed)) {
    return `corepack ${collapsed}`;
  }

  return collapsed;
}

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
const PLANNER_TASK_FITS = PlannerTaskFitSchema.options;

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
  draft?: PlannerDraft;
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

interface DraftModelSelection {
  model: ModelRegistryEntry;
  adjustedFrom?: string;
  adjustmentReason?: string;
}

interface PlanBuild {
  engine: PlanEngine;
  plannerProvider: ProviderId;
  plannerModel: string;
  plannerFallback: boolean;
  plannerAttempts: number;
  draft?: PlannerDraft;
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
    draft: prepared.plan.draft,
  };
}

async function prepareBlueprintPlan(options: GeneratePlanOptions): Promise<PreparedPlan> {
  const root = path.resolve(options.root);
  const context = await loadPlanContext(root);
  const answers = parsePlanAnswers(options.answers);
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

  return parsePlanAnswers({
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
  return parsePlanAnswers(JSON.parse(raw));
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
      reasoningEffort: resolvePlannerReasoningEffort(context, plannerModel.id),
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
    draft: undefined,
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
    const riskAdjustment = adjustDraftTaskRisk(task);
    const riskLevel = riskAdjustment.riskLevel;
    const modelSelection = resolveDraftModelSelection(context, task.suggested_model, task.fit, riskLevel);
    const suggestedModel = modelSelection.model;
    const acceptableAlternatives = resolveDraftAlternatives(
      context,
      task.acceptable_alternatives,
      suggestedModel,
      task.fit,
      riskLevel,
    );
    const modelRationale =
      task.model_rationale ?? defaultModelRationale(suggestedModel, task.fit, riskLevel);
    const contextRules = withDependencyPolicyRule(
      context,
      riskAdjustment.reason
        ? [...task.context_rules, `Risk floor: ${riskAdjustment.reason}`]
        : task.context_rules,
    );
    const rationaleNotes = [
      modelSelection.adjustmentReason
        ? `Routing guard changed suggested_model from ${modelSelection.adjustedFrom} to ${suggestedModel.id}: ${modelSelection.adjustmentReason}`
        : undefined,
      riskAdjustment.reason && task.model_rationale
        ? `Risk floor raised from ${task.risk_level} to ${riskLevel}: ${riskAdjustment.reason}`
        : undefined,
    ].filter((note): note is string => Boolean(note));

    return {
      id: task.id,
      title: task.title,
      filename: `${task.id.replace(/^task-/u, "")}.md`,
      suggestedModel,
      modelRationale: [modelRationale, ...rationaleNotes].join(" "),
      acceptableAlternatives,
      dependencies: task.dependencies,
      allowedPaths: task.allowed_paths,
      forbiddenPaths: task.forbidden_paths.length > 0 ? task.forbidden_paths : defaultForbiddenPaths(),
      riskLevel,
      testCommands: normalizeValidationCommands(
        task.test_commands.length > 0 ? task.test_commands : answers.validationCommands,
      ),
      objective: task.objective,
      contextRules,
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
    draft,
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

function resolveDraftModelSelection(
  context: PlanContext,
  suggestedModel: string | undefined,
  fit: string,
  riskLevel: number,
): DraftModelSelection {
  const activeModels = activeModelsForProfile(context.profile, context.registry);
  const rankedModels = rankModelsForFit(activeModels, fit, riskLevel);
  const bestCapableEntry = resolveBestCapableRankedEntry(rankedModels, fit, riskLevel);

  if (suggestedModel) {
    const model = activeModels.find((candidate) => candidate.id === suggestedModel);

    if (model) {
      const selectedEntry = rankedModels.find((entry) => entry.model.id === model.id);

      if (!selectedEntry) {
        throw new Error(`Planner draft suggested unroutable model ${suggestedModel}.`);
      }

      if (!modelMeetsCapabilityFloor(model, fit, riskLevel)) {
        return {
          model: bestCapableEntry.model,
          adjustedFrom: model.id,
          adjustmentReason: `suggested model is below the adequacy floor (${formatRoutingCapability(
            selectedEntry,
          )}; required fit>=${formatScore(minimumFitForTask(fit, riskLevel))} and non-utility tier for risky non-tiny work)`,
        };
      }

      const capableRankedModels = rankedModels.filter((entry) => modelMeetsCapabilityFloor(entry.model, fit, riskLevel));
      const adjustmentReason = getRoutingAdjustmentReason(selectedEntry, capableRankedModels, fit, riskLevel);
      const bestModel = capableRankedModels[0]?.model;

      if (adjustmentReason && bestModel) {
        return {
          model: bestModel,
          adjustedFrom: model.id,
          adjustmentReason,
        };
      }

      return { model };
    }

    throw new Error(
      `Planner draft suggested unavailable model ${suggestedModel}. Active models: ${
        activeModels.map((candidate) => candidate.id).join(", ") || "none"
      }.`,
    );
  }

  return { model: bestCapableEntry.model };
}

function resolveDraftAlternatives(
  context: PlanContext,
  alternatives: string[],
  selectedModel: ModelRegistryEntry,
  fit: string,
  riskLevel = 5,
): string[] {
  if (alternatives.length === 0) {
    return defaultModelAlternatives(context, selectedModel, fit, riskLevel);
  }

  const activeModels = activeModelsForProfile(context.profile, context.registry);
  const activeModelIds = new Set(activeModels.map((model) => model.id));
  const rankedModels = rankModelsForFit(activeModels, fit, riskLevel);
  const resolved: string[] = [];

  for (const alternative of alternatives) {
    if (!activeModelIds.has(alternative)) {
      throw new Error(
        `Planner draft suggested unavailable alternative model ${alternative}. Active models: ${
          [...activeModelIds].join(", ") || "none"
        }.`,
      );
    }

    const alternativeEntry = rankedModels.find((entry) => entry.model.id === alternative);

    if (
      alternative !== selectedModel.id
      && alternativeEntry
      && isAcceptableRoutingAlternative(alternativeEntry, rankedModels, fit, riskLevel)
    ) {
      resolved.push(alternative);
    }
  }

  const uniqueResolved = uniqueStrings(resolved).slice(0, 3);

  return uniqueResolved.length > 0
    ? uniqueResolved
    : defaultModelAlternatives(context, selectedModel, fit, riskLevel);
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
  riskLevel = 5,
): string[] {
  const rankedModels = rankModelsForFit(activeModelsForProfile(context.profile, context.registry), fit, riskLevel);

  return rankedModels
    .filter((entry) => isAcceptableRoutingAlternative(entry, rankedModels, fit, riskLevel))
    .map((entry) => entry.model)
    .filter((model) => model.id !== selectedModel.id && model.status !== "restricted")
    .slice(0, 2)
    .map((model) => model.id);
}

function withDependencyPolicyRule(context: PlanContext, rules: string[]): string[] {
  const rule = declaredDependencyContextRule(context);

  return rules.some((existingRule) => existingRule === rule) ? rules : [...rules, rule];
}

function declaredDependencyContextRule(context: PlanContext): string {
  const dependencies = summarizeDeclaredDependencies(context.doctor.dependencyManifests ?? []);

  return dependencies.length > 0
    ? `Declared dependencies are the current repo baseline, not a stack lock: ${dependencies.join(", ")}. New frameworks/libraries may be explored, but only become implementation scope after the user's choice/confirmation in the conversation; never justify them from local/global installation.`
    : "No project dependencies are declared yet. Brainstorm stack options freely with tradeoffs, but do not treat locally/globally installed tools as implicit user preference; ask for confirmation before turning a new framework/library into handoff scope.";
}

function summarizeDeclaredDependencies(
  manifests: NonNullable<ProjectDoctorReport["dependencyManifests"]>,
): string[] {
  return uniqueStrings(
    manifests.flatMap((manifest) => [
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    ]),
  ).slice(0, 24);
}

function getRoutingAdjustmentReason(
  selectedEntry: { model: ModelRegistryEntry; score: number; fitScore: number },
  rankedModels: Array<{ model: ModelRegistryEntry; score: number; fitScore: number }>,
  fit: string,
  riskLevel: number,
): string | undefined {
  const bestEntry = rankedModels[0];

  if (!bestEntry || bestEntry.model.id === selectedEntry.model.id) {
    return undefined;
  }

  const scoreGap = bestEntry.score - selectedEntry.score;
  const fitGap = bestEntry.fitScore - selectedEntry.fitScore;
  const selectedTier = modelTierWeight(selectedEntry.model.tier);
  const bestTier = modelTierWeight(bestEntry.model.tier);
  const complexFit = fit !== "tiny_edit";
  const formattedDelta =
    `${selectedEntry.model.id} score=${formatScore(selectedEntry.score)} fit=${formatScore(selectedEntry.fitScore)}; `
    + `${bestEntry.model.id} score=${formatScore(bestEntry.score)} fit=${formatScore(bestEntry.fitScore)}`;

  if (
    riskLevel >= 7
    && (scoreGap > 0.08 || fitGap > 0.1 || (selectedTier <= 2 && bestTier >= 3))
  ) {
    return `high-risk ${fit} task is underfit (${formattedDelta})`;
  }

  if (
    riskLevel >= 5
    && (scoreGap > 0.14 || fitGap > 0.18 || (complexFit && selectedTier <= 2 && bestEntry.fitScore >= 0.85))
  ) {
    return `risk ${riskLevel} ${fit} task is underfit (${formattedDelta})`;
  }

  if (riskLevel <= 3 && fit === "tiny_edit" && selectedTier >= 4 && scoreGap > 0.12) {
    return `low-risk tiny_edit should use the cheaper capable model (${formattedDelta})`;
  }

  if (riskLevel <= 4 && complexFit && fitGap > 0.28 && scoreGap > 0.1) {
    return `low-risk ${fit} suggestion still trails the active pool too far (${formattedDelta})`;
  }

  return undefined;
}

function isAcceptableRoutingAlternative(
  alternativeEntry: { model: ModelRegistryEntry; score: number; fitScore: number },
  rankedModels: Array<{ model: ModelRegistryEntry; score: number; fitScore: number }>,
  fit: string,
  riskLevel: number,
): boolean {
  if (!modelMeetsCapabilityFloor(alternativeEntry.model, fit, riskLevel)) {
    return false;
  }

  const bestEntry = rankedModels[0];

  if (!bestEntry || alternativeEntry.model.id === bestEntry.model.id) {
    return true;
  }

  const scoreGap = bestEntry.score - alternativeEntry.score;
  const fitGap = bestEntry.fitScore - alternativeEntry.fitScore;
  const alternativeTier = modelTierWeight(alternativeEntry.model.tier);
  const bestTier = modelTierWeight(bestEntry.model.tier);
  const complexFit = fit !== "tiny_edit";

  if (riskLevel >= 7) {
    return scoreGap <= 0.14 && fitGap <= 0.16 && !(alternativeTier <= 2 && bestTier >= 3);
  }

  if (riskLevel >= 5) {
    return scoreGap <= 0.22 && fitGap <= 0.25 && !(complexFit && alternativeTier <= 2 && bestTier >= 4);
  }

  if (complexFit) {
    return fitGap <= 0.35 || alternativeEntry.fitScore >= 0.68;
  }

  return true;
}

function resolveBestCapableRankedEntry(
  rankedModels: Array<{ model: ModelRegistryEntry; score: number; fitScore: number }>,
  fit: string,
  riskLevel: number,
): { model: ModelRegistryEntry; score: number; fitScore: number } {
  const capableEntry = rankedModels.find((entry) => modelMeetsCapabilityFloor(entry.model, fit, riskLevel));

  if (capableEntry) {
    return capableEntry;
  }

  const bestEntry = rankedModels[0];

  if (!bestEntry) {
    throw new Error(`No active models are available for risk ${riskLevel} ${fit} task.`);
  }

  throw new Error(
    `No adequate active model for risk ${riskLevel} ${fit} task. Best candidate ${
      bestEntry.model.id
    } has fit=${formatScore(bestEntry.fitScore)} tier=${
      bestEntry.model.tier
    }. Enable a stronger model or split/lower the task scope before generating handoffs.`,
  );
}

function formatRoutingCapability(entry: { model: ModelRegistryEntry; fitScore: number }): string {
  return `${entry.model.id} fit=${formatScore(entry.fitScore)} tier=${entry.model.tier}`;
}

function modelMeetsCapabilityFloor(model: ModelRegistryEntry, fit: string, riskLevel: number): boolean {
  const fitScore = model.task_fit[fit] ?? 0;
  const minimumFit = minimumFitForTask(fit, riskLevel);

  if (fitScore < minimumFit) {
    return false;
  }

  if (riskLevel >= 5 && fit !== "tiny_edit" && model.tier === "utility") {
    return false;
  }

  return true;
}

function minimumFitForTask(fit: string, riskLevel: number): number {
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

function adjustDraftTaskRisk(task: PlannerDraft["tasks"][number]): { riskLevel: number; reason?: string } {
  const signals = [
    task.title,
    task.objective,
    task.execution_prompt,
    task.allowed_paths.join(" "),
    task.context_rules.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  const allowedPaths = task.allowed_paths.join(" ");
  const floors: Array<{ value: number; reason: string }> = [];

  if (/\bsrc\/tui\.ts\b|\bsrc\/cli\.ts\b/u.test(allowedPaths)) {
    floors.push({ value: 5, reason: "touches global CLI or TUI orchestration files" });
  }

  if (/\bsrc\/providers\.ts\b|\bsrc\/plannerEngine\.ts\b|\bsrc\/models\.ts\b/u.test(allowedPaths)) {
    floors.push({ value: 4, reason: "touches provider, model routing, or planner engine contracts" });
  }

  if (
    /fallback|auth|provider|plannerengine|semantic checkbox|unified chat|agentic|orchestrator|global state/u.test(signals)
  ) {
    floors.push({ value: 5, reason: "contains agentic workflow, fallback, provider, or global-state risk signals" });
  }

  if (task.allowed_paths.length >= 4 || task.allowed_paths.some((allowedPath) => allowedPath.includes("**/*"))) {
    floors.push({ value: 4, reason: "has a broad or multi-file write surface" });
  }

  const floor = floors.sort((left, right) => right.value - left.value)[0];
  const riskLevel = clampRisk(Math.max(task.risk_level, floor?.value ?? task.risk_level));

  return riskLevel > task.risk_level
    ? { riskLevel, reason: floor?.reason ?? "risk floor applied" }
    : { riskLevel };
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

function resolvePlannerReasoningEffort(context: PlanContext, modelId: string): string | undefined {
  return (
    context.profile.planner_reasoning_effort
    ?? context.profile.model_reasoning_efforts[modelId]
    ?? context.registry.find((model) => model.id === modelId)?.default_reasoning_effort
  );
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
  const activeRegistryModels = activeModelsForProfile(context.profile, context.registry);
  const activeModels = activeRegistryModels.map((model) => ({
    id: model.id,
    provider: model.provider,
    status: model.status,
    tier: model.tier,
    task_fit: model.task_fit,
    context_window: model.context_window,
    max_output_tokens: model.max_output_tokens,
    input_price_usd_per_mtok: model.input_price_usd_per_mtok,
    output_price_usd_per_mtok: model.output_price_usd_per_mtok,
    reasoning_efforts: model.reasoning_efforts,
    default_reasoning_effort: model.default_reasoning_effort,
    selected_reasoning_effort:
      context.profile.model_reasoning_efforts[model.id] ?? model.default_reasoning_effort ?? model.reasoning_efforts[0],
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
      planner_reasoning_effort: context.profile.planner_reasoning_effort,
      available_providers: context.profile.available_providers,
      available_models: context.profile.available_models,
      model_reasoning_efforts: context.profile.model_reasoning_efforts,
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
      declared_dependencies: context.doctor.dependencyManifests ?? [],
      top_level_dirs: context.doctor.topLevelDirs,
      inventory_files: context.doctor.inventoryFiles,
      markdown_headings: context.doctor.markdownHeadings,
      blocked_patterns: context.doctor.blockedPatterns,
      warnings: context.doctor.warnings,
    },
    active_models: activeModels,
    routing_scorecards: buildRoutingScorecards(activeRegistryModels),
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
    "- Use routing_scorecards as the first routing prior: low_risk_order for risk <= 4, high_risk_order for risk >= 7, and task_fit plus rationale for the middle.",
    "- Do not blindly pick the largest model. Use frontier models when risk, context, ambiguity, or benchmark needs justify them.",
    "- Do not underfit. If a task edits core architecture, security, data loss paths, or many files, prefer high_risk_order even when a cheaper model is available.",
    "- Use benchmark_scores, routing_tags, task_fit, reasoning_efforts, default_reasoning_effort, context_window, latency_class, and prices when choosing a model.",
    "- Treat selected_reasoning_effort as the configured execution effort for that exact model.",
    "- If a task is read-only, set allowed_paths to [] and say read-only in context_rules.",
    "- If a task edits files, allowed_paths must be the narrowest relative paths or globs needed.",
    "- Prefer existing paths from project_inventory.inventory_files and existing top-level directories.",
    "- Do not invent new source or test directories unless the requested change clearly requires them; if a new directory is required, state that explicitly in context_rules.",
    "- Treat project_inventory.stack as repo evidence for the current baseline, not as a lock that prevents architectural brainstorming.",
    "- You may propose frameworks, packages, libraries, build tools, databases, or test frameworks during brainstorming when they fit the user's goals; present them as options with tradeoffs until the user chooses.",
    "- Never recommend a framework, package, library, build tool, database, or test framework because it is installed globally or available on the user's machine.",
    "- Prefer already-declared dependencies when the user wants to extend the current repo. If you propose a new dependency, label it as requiring confirmation before it becomes handoff scope.",
    "- Before preview_plan or generated tasks, any new framework/library choice must be explicitly requested by the user or listed as a pending decision/question instead of a settled implementation instruction.",
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
  const contextRisk = clampRisk(answers.riskLevel - 2);
  const validationRisk = clampRisk(answers.riskLevel - 1);
  const contextModel = selectModel(context, "long_context", contextRisk);
  const implementationModel = selectModel(context, "coding_heavy", answers.riskLevel);
  const validationModel = selectModel(context, "review", validationRisk);

  return [
    {
      id: "task-001-context-map",
      title: "Map current context and contracts",
      filename: "001-context-map.md",
      suggestedModel: contextModel,
      modelRationale: defaultModelRationale(contextModel, "long_context", contextRisk),
      acceptableAlternatives: defaultModelAlternatives(context, contextModel, "long_context", contextRisk),
      dependencies: [],
      allowedPaths: [],
      forbiddenPaths,
      riskLevel: contextRisk,
      testCommands: [],
      objective: "Inspect the project context and return a concise implementation map before any file edits.",
      contextRules: [
        "This is a read-only task. Do not edit files.",
        `Use only visible project context under ${context.root}.`,
        `Detected stack: ${context.doctor.stack.join(", ") || "unknown"}.`,
        declaredDependencyContextRule(context),
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
      suggestedModel: implementationModel,
      modelRationale: defaultModelRationale(implementationModel, "coding_heavy", answers.riskLevel),
      acceptableAlternatives: defaultModelAlternatives(context, implementationModel, "coding_heavy", answers.riskLevel),
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
        declaredDependencyContextRule(context),
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
      suggestedModel: validationModel,
      modelRationale: defaultModelRationale(validationModel, "review", validationRisk),
      acceptableAlternatives: defaultModelAlternatives(context, validationModel, "review", validationRisk),
      dependencies: ["task-002-implement-core-work"],
      allowedPaths: validationPaths,
      forbiddenPaths,
      riskLevel: validationRisk,
      testCommands: answers.validationCommands,
      objective: "Review the implemented work, run validation, and prepare final integration notes.",
      contextRules: [
        `Validation commands: ${answers.validationCommands.join(" && ") || "manual verification required"}.`,
        `Allowed write paths for fixes/docs: ${validationPaths.join(", ")}.`,
        "Do not expand implementation scope. Only fix issues needed to satisfy acceptance.",
        declaredDependencyContextRule(context),
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
- Declared dependencies: ${summarizeDeclaredDependencies(context.doctor.dependencyManifests ?? []).join(", ") || "none"}
- Scripts: ${Object.keys(context.doctor.scripts).join(", ") || "none"}
- Top-level dirs: ${context.doctor.topLevelDirs.join(", ") || "none"}
- Blocked patterns: ${context.doctor.blockedPatterns.join(", ")}

## Work Breakdown

${plan.tasks.map((task) => `- ${task.id}: ${task.title} (${task.suggestedModel.id})`).join("\n")}

## Constraints

${formatMarkdownList(answers.constraints)}

## Dependency Policy

- ${declaredDependencyContextRule(context)}

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

function selectModel(context: PlanContext, fit: string, riskLevel = 5): ModelRegistryEntry {
  const activeModels = activeModelsForProfile(context.profile, context.registry);
  const rankedModels = rankModelsForFit(activeModels, fit, riskLevel);

  return resolveBestCapableRankedEntry(rankedModels, fit, riskLevel).model;
}

function buildRoutingScorecards(models: ModelRegistryEntry[]): Array<{
  fit: string;
  low_risk_order: Array<{ model: string; score: number; fit: number; tier: string; latency: string; cost: string }>;
  high_risk_order: Array<{ model: string; score: number; fit: number; tier: string; latency: string; cost: string }>;
}> {
  return PLANNER_TASK_FITS.map((fit) => ({
    fit,
    low_risk_order: rankModelsForFit(models, fit, 3).map(formatRoutingScorecardEntry),
    high_risk_order: rankModelsForFit(models, fit, 8).map(formatRoutingScorecardEntry),
  }));
}

function rankModelsForFit(
  models: ModelRegistryEntry[],
  fit: string,
  riskLevel: number,
): Array<{ model: ModelRegistryEntry; score: number; fitScore: number }> {
  return models
    .filter((model) => model.status !== "restricted")
    .map((model) => {
      const fitScore = model.task_fit[fit] ?? 0;

      return {
        model,
        fitScore,
        score: scoreModelForFit(model, fitScore, riskLevel),
      };
    })
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;

      if (Math.abs(scoreDiff) >= 0.001) {
        return scoreDiff;
      }

      const fitDiff = right.fitScore - left.fitScore;

      if (fitDiff !== 0) {
        return fitDiff;
      }

      return left.model.id.localeCompare(right.model.id);
    });
}

function formatRoutingScorecardEntry(entry: { model: ModelRegistryEntry; score: number; fitScore: number }): {
  model: string;
  score: number;
  fit: number;
  tier: string;
  latency: string;
  cost: string;
} {
  return {
    model: entry.model.id,
    score: Number(entry.score.toFixed(3)),
    fit: Number(entry.fitScore.toFixed(3)),
    tier: entry.model.tier,
    latency: entry.model.latency_class,
    cost: entry.model.cost_class,
  };
}

function scoreModelForFit(model: ModelRegistryEntry, fitScore: number, riskLevel: number): number {
  const highRisk = riskLevel >= 7;
  const lowRisk = riskLevel <= 4;
  const tierScore = modelTierWeight(model.tier) / 4;
  const latencyScore = latencyWeight(model.latency_class) / 3;
  const contextScore = contextWindowScore(model.context_window);
  const costScore = priceEfficiencyScore(model);
  const stabilityScore = model.status === "stable" ? 1 : model.status === "preview" ? 0.72 : 0.2;

  if (highRisk) {
    return fitScore * 0.55 + tierScore * 0.2 + contextScore * 0.15 + stabilityScore * 0.05 + latencyScore * 0.05;
  }

  if (lowRisk) {
    return fitScore * 0.45 + costScore * 0.25 + latencyScore * 0.15 + stabilityScore * 0.1 + contextScore * 0.05;
  }

  return fitScore * 0.5 + tierScore * 0.15 + contextScore * 0.12 + costScore * 0.1 + latencyScore * 0.08 + stabilityScore * 0.05;
}

function contextWindowScore(contextWindow: number | undefined): number {
  if (!contextWindow) {
    return 0.4;
  }

  if (contextWindow >= 1_000_000) {
    return 1;
  }

  if (contextWindow >= 400_000) {
    return 0.78;
  }

  if (contextWindow >= 200_000) {
    return 0.58;
  }

  return 0.35;
}

function priceEfficiencyScore(model: ModelRegistryEntry): number {
  const total = (model.input_price_usd_per_mtok ?? 0) + (model.output_price_usd_per_mtok ?? 0);

  if (total <= 0) {
    if (model.cost_class === "free") {
      return 1;
    }

    if (model.cost_class === "subscription") {
      return 0.7;
    }

    return 0.5;
  }

  if (total <= 2) {
    return 1;
  }

  if (total <= 5) {
    return 0.9;
  }

  if (total <= 10) {
    return 0.78;
  }

  if (total <= 20) {
    return 0.62;
  }

  if (total <= 40) {
    return 0.48;
  }

  if (total <= 100) {
    return 0.32;
  }

  return 0.18;
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
