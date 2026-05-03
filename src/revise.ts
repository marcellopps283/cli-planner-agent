import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import { stringify } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { lintBlueprint } from "./lint.js";
import { loadPlannerProfile } from "./profile.js";
import { extractJsonObject, runProviderPrompt } from "./providerPrompt.js";
import {
  BlueprintTaskMetadataSchema,
  DependencyGraphSchema,
  type BlueprintTaskMetadata,
  type DependencyGraph,
} from "./schemas.js";

export const RevisionClassSchema = z.enum([
  "local_doc",
  "task_local",
  "graph_local",
  "architecture_subtree",
  "global_replan",
]);

export type RevisionClass = z.infer<typeof RevisionClassSchema>;

export const RevisionPlanSchema = z.object({
  schema_version: z.literal("1.0"),
  created_at: z.iso.datetime(),
  change: z.string().min(1),
  classification: RevisionClassSchema,
  confidence: z.number().min(0).max(1),
  affected_files: z.array(z.string()),
  affected_tasks: z.array(z.string()),
  rationale: z.array(z.string()),
  recommended_action: z.string().min(1),
  application: z
    .object({
      status: z.enum(["not_requested", "applied", "failed", "unsupported"]).default("not_requested"),
      target_file: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      error: z.string().min(1).optional(),
    })
    .default({ status: "not_requested" }),
});

export type RevisionPlan = z.infer<typeof RevisionPlanSchema>;

const RevisedDocumentSchema = z.object({
  schema_version: z.literal("1.0"),
  content: z.string().min(1),
  summary: z.string().min(1),
});

export type RevisedDocument = z.infer<typeof RevisedDocumentSchema>;

export interface ReviseOptions {
  root: string;
  change: string;
  dryRun?: boolean;
  apply?: boolean;
  applyTimeoutMs?: number;
  localDocRewriter?: (request: LocalDocRewriteRequest) => Promise<RevisedDocument>;
  taskRewriter?: (request: TaskRewriteRequest) => Promise<RevisedDocument>;
}

export interface ReviseResult {
  plan: RevisionPlan;
  writtenPath?: string;
  appliedPath?: string;
}

export interface LocalDocRewriteRequest {
  root: string;
  blueprintRoot: string;
  file: string;
  change: string;
  currentContent: string;
}

export interface TaskRewriteRequest {
  root: string;
  blueprintRoot: string;
  file: string;
  taskId: string;
  change: string;
  currentContent: string;
  currentMetadata: BlueprintTaskMetadata;
}

interface BlueprintTaskIndexEntry {
  id: string;
  file: string;
  metadata: BlueprintTaskMetadata;
  content: string;
}

interface BlueprintRevisionIndex {
  blueprintRoot: string;
  files: Array<{ file: string; content: string }>;
  tasks: BlueprintTaskIndexEntry[];
  graph?: DependencyGraph;
}

interface GraphDependencyOperation {
  action: "add" | "remove";
  from: string;
  to: string;
  summary: string;
}

const DOC_FILES = [
  "architecture.md",
  "assumptions.md",
  "decisions.md",
  "risks.md",
  "integration_guide.md",
  "blueprint.yaml",
  "dependencies_graph.json",
];

const GLOBAL_REPLAN_PATTERNS = [
  /\b(global|todo|inteiro|replanej|refa[cç]a|reescrev|rewrite)\b/iu,
  /\b(stack|framework|runtime|linguagem|arquitetura inteira|monorepo)\b/iu,
  /\b(react|next|vue|svelte|node|python|go|rust|java)\s*(para|to|->)\s*(react|next|vue|svelte|node|python|go|rust|java)\b/iu,
];

const ARCHITECTURE_PATTERNS = [
  /\b(banco|database|db|postgres|postgresql|mongo|mongodb|mysql|sqlite|redis|fila|queue)\b/iu,
  /\b(auth|oauth|login|provedor|provider|modelo|registry|roteamento|routing)\b/iu,
  /\b(infra|deploy|cloud|vps|docker|kubernetes|terraform|ansible)\b/iu,
];

const STRONG_GRAPH_PATTERNS = [
  /\b(depend[eê]ncia|dependency|depende|bloqueia|desbloqueia|ordem|paralel|parallel)\b/iu,
  /\b(grafo|graph|edge|node|fase|batch)\b/iu,
];

const WEAK_GRAPH_PATTERNS = [/\b(antes|depois)\b/iu];

const GRAPH_PATTERNS = [...STRONG_GRAPH_PATTERNS, ...WEAK_GRAPH_PATTERNS];

const DOC_PATTERNS = [/\b(doc|docs|readme|documenta|texto|copy|guia|manual)\b/iu];

const REQUIRED_XML_BLOCKS = [
  "task_objective",
  "suggested_model",
  "context_rules",
  "execution_prompt",
  "acceptance_contract",
];

export async function reviseBlueprint(options: ReviseOptions): Promise<ReviseResult> {
  const root = path.resolve(options.root);
  const index = await buildRevisionIndex(root);
  const plan = classifyRevision(index, options.change);
  let writtenPath: string | undefined;
  let appliedPath: string | undefined;

  if (options.apply && !options.dryRun) {
    const application = await applyRevision(root, index, plan, options);
    plan.application = application.plan.application;
    appliedPath = application.appliedPath;
  }

  if (!options.dryRun) {
    writtenPath = await writeRevisionPlan(index.blueprintRoot, plan);
  }

  return { plan, writtenPath, appliedPath };
}

export async function readChangeInput(change: string | undefined, file: string | undefined): Promise<string> {
  if (change && file) {
    throw new Error("Use either --change or --file, not both.");
  }

  if (change?.trim()) {
    return change.trim();
  }

  if (file) {
    const raw = await readFile(path.resolve(file), "utf8");
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      throw new Error(`Change file is empty: ${file}`);
    }

    return trimmed;
  }

  throw new Error("Missing change input. Use --change <text> or --file <path>.");
}

export function classifyRevision(index: BlueprintRevisionIndex, changeInput: string): RevisionPlan {
  const change = changeInput.trim();
  const tokens = tokenize(change);
  const explicitPaths = extractPathLikes(change);
  const explicitTaskIds = extractTaskReferences(change, index.tasks);
  const scoredFiles = scoreFiles(index, tokens, explicitPaths);
  const scoredTasks = scoreTasks(index, tokens, explicitPaths, explicitTaskIds);
  const rawAffectedFiles = selectAffectedFiles(scoredFiles, explicitPaths);
  const rawAffectedTasks = selectAffectedTasks(scoredTasks, explicitTaskIds);
  const classification = chooseRevisionClass(change, rawAffectedFiles, rawAffectedTasks, explicitPaths, explicitTaskIds);
  const affectedTasks = refineAffectedTasks(classification, rawAffectedTasks, explicitTaskIds);
  const affectedFiles = refineAffectedFiles(index, classification, rawAffectedFiles, affectedTasks, explicitPaths);
  const rationale = buildRationale(change, affectedFiles, affectedTasks, classification, explicitPaths, explicitTaskIds);

  return RevisionPlanSchema.parse({
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    change,
    classification,
    confidence: estimateConfidence(classification, affectedFiles, affectedTasks, explicitPaths, explicitTaskIds),
    affected_files: affectedFiles,
    affected_tasks: affectedTasks,
    rationale,
    recommended_action: recommendedAction(classification),
    application: {
      status: "not_requested",
    },
  });
}

async function applyRevision(
  root: string,
  index: BlueprintRevisionIndex,
  plan: RevisionPlan,
  options: ReviseOptions,
): Promise<{ plan: RevisionPlan; appliedPath?: string }> {
  if (plan.classification === "local_doc") {
    return applyLocalDocRevision(root, index, plan, options);
  }

  if (plan.classification === "task_local") {
    return applyTaskLocalRevision(root, index, plan, options);
  }

  if (plan.classification === "graph_local") {
    return applyGraphLocalRevision(root, index, plan);
  }

  return {
    plan: {
      ...plan,
      application: {
        status: "unsupported",
        error: `--apply currently supports local_doc, task_local, and explicit graph_local dependency edits only, received ${plan.classification}.`,
      },
    },
  };
}

async function applyLocalDocRevision(
  root: string,
  index: BlueprintRevisionIndex,
  plan: RevisionPlan,
  options: ReviseOptions,
): Promise<{ plan: RevisionPlan; appliedPath?: string }> {
  const targetFile = selectLocalDocApplyTarget(index, plan);

  if (!targetFile) {
    return {
      plan: {
        ...plan,
        application: {
          status: "unsupported",
          error: "No single managed markdown document was identified for local_doc apply.",
        },
      },
    };
  }

  try {
    const currentContent = await readFile(path.join(index.blueprintRoot, targetFile), "utf8");
    const request: LocalDocRewriteRequest = {
      root,
      blueprintRoot: index.blueprintRoot,
      file: targetFile,
      change: plan.change,
      currentContent,
    };
    const revised = options.localDocRewriter
      ? await options.localDocRewriter(request)
      : await rewriteLocalDocWithProvider(root, request, options.applyTimeoutMs);
    const targetPath = path.join(index.blueprintRoot, targetFile);

    await writeFile(targetPath, revised.content, "utf8");

    return {
      plan: {
        ...plan,
        application: {
          status: "applied",
          target_file: targetFile,
          summary: revised.summary,
        },
      },
      appliedPath: targetPath,
    };
  } catch (error) {
    return {
      plan: {
        ...plan,
        application: {
          status: "failed",
          target_file: targetFile,
          error: summarizeApplyError(error),
        },
      },
    };
  }
}

async function applyTaskLocalRevision(
  root: string,
  index: BlueprintRevisionIndex,
  plan: RevisionPlan,
  options: ReviseOptions,
): Promise<{ plan: RevisionPlan; appliedPath?: string }> {
  const targetTask = selectTaskApplyTarget(index, plan);

  if (!targetTask) {
    return {
      plan: {
        ...plan,
        application: {
          status: "unsupported",
          error: "No single task file was identified for task_local apply.",
        },
      },
    };
  }

  try {
    const targetPath = path.join(index.blueprintRoot, targetTask.file);
    const currentContent = await readFile(targetPath, "utf8");
    const request: TaskRewriteRequest = {
      root,
      blueprintRoot: index.blueprintRoot,
      file: targetTask.file,
      taskId: targetTask.id,
      change: plan.change,
      currentContent,
      currentMetadata: BlueprintTaskMetadataSchema.parse(targetTask.metadata),
    };
    const revised = options.taskRewriter
      ? await options.taskRewriter(request)
      : await rewriteTaskWithProvider(root, request, options.applyTimeoutMs);

    validateTaskRevisionContent(request, revised.content);
    await writeFileWithLintRollback(root, targetPath, currentContent, revised.content);

    return {
      plan: {
        ...plan,
        application: {
          status: "applied",
          target_file: targetTask.file,
          summary: revised.summary,
        },
      },
      appliedPath: targetPath,
    };
  } catch (error) {
    return {
      plan: {
        ...plan,
        application: {
          status: "failed",
          target_file: targetTask.file,
          error: summarizeApplyError(error),
        },
      },
    };
  }
}

async function applyGraphLocalRevision(
  root: string,
  index: BlueprintRevisionIndex,
  plan: RevisionPlan,
): Promise<{ plan: RevisionPlan; appliedPath?: string }> {
  const operation = extractGraphDependencyOperation(plan.change, index);

  if (!operation) {
    return {
      plan: {
        ...plan,
        application: {
          status: "unsupported",
          error: "No explicit two-task dependency operation was identified for graph_local apply.",
        },
      },
    };
  }

  if (!index.graph) {
    return {
      plan: {
        ...plan,
        application: {
          status: "unsupported",
          error: "dependencies_graph.json was not available for graph_local apply.",
        },
      },
    };
  }

  try {
    const rewrite = buildGraphDependencyRewrite(index, operation);
    const graphPath = path.join(index.blueprintRoot, "dependencies_graph.json");
    const taskPath = path.join(index.blueprintRoot, rewrite.task.file);
    const previousGraph = await readFile(graphPath, "utf8");
    const previousTask = await readFile(taskPath, "utf8");

    await writeFilesWithLintRollback(root, [
      {
        path: graphPath,
        previousContent: previousGraph,
        nextContent: `${JSON.stringify(rewrite.graph, null, 2)}\n`,
      },
      {
        path: taskPath,
        previousContent: previousTask,
        nextContent: rewrite.task.content,
      },
    ]);

    return {
      plan: {
        ...plan,
        application: {
          status: "applied",
          target_file: "dependencies_graph.json",
          summary: operation.summary,
        },
      },
      appliedPath: graphPath,
    };
  } catch (error) {
    return {
      plan: {
        ...plan,
        application: {
          status: "failed",
          target_file: "dependencies_graph.json",
          error: summarizeApplyError(error),
        },
      },
    };
  }
}

function selectLocalDocApplyTarget(index: BlueprintRevisionIndex, plan: RevisionPlan): string | undefined {
  const managedDocs = new Set(index.files.map((file) => file.file).filter((file) => file.endsWith(".md")));
  const candidates = plan.affected_files.filter((file) => managedDocs.has(file));

  return candidates.length === 1 ? candidates[0] : undefined;
}

function selectTaskApplyTarget(index: BlueprintRevisionIndex, plan: RevisionPlan): BlueprintTaskIndexEntry | undefined {
  if (plan.affected_tasks.length !== 1) {
    return undefined;
  }

  return index.tasks.find((task) => task.id === plan.affected_tasks[0]);
}

async function rewriteLocalDocWithProvider(
  root: string,
  request: LocalDocRewriteRequest,
  timeoutMs: number | undefined,
): Promise<RevisedDocument> {
  const profileResult = await loadPlannerProfile(root);

  if (profileResult.errors.length > 0 || !profileResult.profile) {
    throw new Error(`Profile is not ready.\n${profileResult.errors.join("\n")}`);
  }

  const prompt = buildLocalDocRewritePrompt(request);
  const result = await runProviderPrompt({
    provider: profileResult.profile.planner_provider,
    prompt,
    timeoutMs,
  });

  return parseRevisedDocument(result.response);
}

async function rewriteTaskWithProvider(
  root: string,
  request: TaskRewriteRequest,
  timeoutMs: number | undefined,
): Promise<RevisedDocument> {
  const profileResult = await loadPlannerProfile(root);

  if (profileResult.errors.length > 0 || !profileResult.profile) {
    throw new Error(`Profile is not ready.\n${profileResult.errors.join("\n")}`);
  }

  const prompt = buildTaskRewritePrompt(request);
  const result = await runProviderPrompt({
    provider: profileResult.profile.planner_provider,
    prompt,
    timeoutMs,
  });

  return parseRevisedDocument(result.response);
}

export function buildLocalDocRewritePrompt(request: LocalDocRewriteRequest): string {
  return [
    "You are revising one generated blueprint documentation artifact.",
    "Return ONLY JSON parseable by JSON.parse. Do not include markdown fences.",
    "Schema:",
    JSON.stringify(
      {
        schema_version: "1.0",
        content: "full replacement markdown content",
        summary: "short summary of the applied revision",
      },
      null,
      2,
    ),
    "Rules:",
    "- Rewrite only the provided document.",
    "- Preserve useful existing structure unless the change requires a local edit.",
    "- Do not invent execution results.",
    "- Do not modify task ids, graph edges, or unrelated documents.",
    "- Keep generated-file comments if they already exist.",
    "Target file:",
    request.file,
    "Change request:",
    request.change,
    "Current content:",
    request.currentContent,
  ].join("\n\n");
}

export function buildTaskRewritePrompt(request: TaskRewriteRequest): string {
  return [
    "You are revising exactly one generated blueprint task handoff.",
    "Return ONLY JSON parseable by JSON.parse. Do not include markdown fences.",
    "Schema:",
    JSON.stringify(
      {
        schema_version: "1.0",
        content: "full replacement markdown content, including YAML frontmatter and XML blocks",
        summary: "short summary of the applied revision",
      },
      null,
      2,
    ),
    "Rules:",
    "- Rewrite only the provided task markdown.",
    "- Preserve YAML frontmatter unless the requested local edit requires a non-graph metadata clarification.",
    `- Preserve frontmatter id exactly as ${request.currentMetadata.id}.`,
    `- Preserve frontmatter dependencies exactly as ${JSON.stringify(request.currentMetadata.dependencies ?? [])}.`,
    "- Do not edit dependencies_graph.json, task ids, graph edges, or other task files.",
    "- Keep all required XML blocks present and non-empty:",
    REQUIRED_XML_BLOCKS.map((block) => `  - <${block}>...</${block}>`).join("\n"),
    "- Keep the task usable as a copy/paste handoff for a worker model.",
    "- Do not invent validation results or claim commands were run.",
    "Target task:",
    request.taskId,
    "Target file:",
    request.file,
    "Change request:",
    request.change,
    "Current task markdown:",
    request.currentContent,
  ].join("\n\n");
}

export function parseRevisedDocument(response: string): RevisedDocument {
  const json = extractJsonObject(response);
  return RevisedDocumentSchema.parse(JSON.parse(json));
}

function validateTaskRevisionContent(request: TaskRewriteRequest, content: string): void {
  const parsed = matter(content);
  const metadata = BlueprintTaskMetadataSchema.parse(parsed.data);

  if (metadata.id !== request.currentMetadata.id) {
    throw new Error(`Task rewrite changed frontmatter id from ${request.currentMetadata.id} to ${metadata.id}.`);
  }

  const expectedDependencies = request.currentMetadata.dependencies ?? [];
  const actualDependencies = metadata.dependencies ?? [];

  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(
      `Task rewrite changed dependencies from ${JSON.stringify(expectedDependencies)} to ${JSON.stringify(actualDependencies)}.`,
    );
  }

  for (const block of REQUIRED_XML_BLOCKS) {
    if (!hasXmlBlock(parsed.content, block)) {
      throw new Error(`Task rewrite removed or emptied <${block}> block.`);
    }
  }
}

async function writeFileWithLintRollback(
  root: string,
  targetPath: string,
  previousContent: string,
  nextContent: string,
): Promise<void> {
  await writeFilesWithLintRollback(root, [{ path: targetPath, previousContent, nextContent }]);
}

async function writeFilesWithLintRollback(
  root: string,
  changes: Array<{ path: string; previousContent: string; nextContent: string }>,
): Promise<void> {
  for (const change of changes) {
    await writeFile(change.path, change.nextContent, "utf8");
  }

  const lint = await lintBlueprint(root);

  if (lint.errors.length === 0) {
    return;
  }

  for (const change of changes) {
    await writeFile(change.path, change.previousContent, "utf8");
  }

  throw new Error(`Blueprint lint failed after apply: ${lint.errors.join(" | ")}`);
}

function hasXmlBlock(content: string, tag: string): boolean {
  const pattern = new RegExp(`<${tag}>[\\s\\S]+?</${tag}>`, "u");
  return pattern.test(content);
}

function extractGraphDependencyOperation(
  change: string,
  index: BlueprintRevisionIndex,
): GraphDependencyOperation | undefined {
  const orderedTasks = extractOrderedTaskReferences(change, index.tasks);

  if (orderedTasks.length !== 2) {
    return undefined;
  }

  const normalized = normalizeSearchText(change);
  const action: GraphDependencyOperation["action"] = /\b(remova|remover|remove|delete|retire|retirar|sem depender|nao depender|não depender)\b/iu.test(
    normalized,
  )
    ? "remove"
    : "add";
  const firstTask = orderedTasks[0]!;
  const secondTask = orderedTasks[1]!;
  let from = secondTask;
  let to = firstTask;

  if (/\b(antes|before)\b/iu.test(normalized)) {
    from = firstTask;
    to = secondTask;
  } else if (/\b(depois|after)\b/iu.test(normalized)) {
    from = secondTask;
    to = firstTask;
  } else if (/\b(bloqueia|blocks?|unblocks?|desbloqueia)\b/iu.test(normalized)) {
    from = firstTask;
    to = secondTask;
  } else if (!/\b(depend[a-z]*|dependency|dependencia)\b/iu.test(normalized)) {
    return undefined;
  }

  return {
    action,
    from,
    to,
    summary:
      action === "add"
        ? `Added dependency edge ${from} -> ${to}.`
        : `Removed dependency edge ${from} -> ${to}.`,
  };
}

function buildGraphDependencyRewrite(
  index: BlueprintRevisionIndex,
  operation: GraphDependencyOperation,
): { graph: DependencyGraph; task: { file: string; content: string } } {
  if (!index.graph) {
    throw new Error("dependencies_graph.json is missing.");
  }

  if (operation.from === operation.to) {
    throw new Error(`Task ${operation.to} cannot depend on itself.`);
  }

  const graph = cloneDependencyGraph(index.graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fromNode = nodesById.get(operation.from);
  const toNode = nodesById.get(operation.to);

  if (!fromNode) {
    throw new Error(`Dependency source task not found in graph: ${operation.from}.`);
  }

  if (!toNode) {
    throw new Error(`Dependency target task not found in graph: ${operation.to}.`);
  }

  if (operation.action === "add" && dependsOn(graph, operation.from, operation.to)) {
    throw new Error(`Adding ${operation.from} -> ${operation.to} would create a dependency cycle.`);
  }

  toNode.depends_on =
    operation.action === "add"
      ? unique([...toNode.depends_on, operation.from])
      : toNode.depends_on.filter((dependency) => dependency !== operation.from);
  graph.edges = rebuildGraphEdges(graph);
  const task = index.tasks.find((entry) => entry.id === operation.to);

  if (!task) {
    throw new Error(`Dependency target task file not found: ${operation.to}.`);
  }

  const parsedTask = matter(task.content);
  const metadata = BlueprintTaskMetadataSchema.parse(parsedTask.data);
  const nextMetadata: BlueprintTaskMetadata = {
    ...metadata,
    dependencies:
      operation.action === "add"
        ? unique([...metadata.dependencies, operation.from])
        : metadata.dependencies.filter((dependency) => dependency !== operation.from),
  };
  const nextTaskContent = renderTaskMarkdown(parsedTask.content, nextMetadata);

  DependencyGraphSchema.parse(graph);
  validateTaskRevisionContent(
    {
      root: "",
      blueprintRoot: index.blueprintRoot,
      file: task.file,
      taskId: task.id,
      change: operation.summary,
      currentContent: task.content,
      currentMetadata: {
        ...metadata,
        dependencies: nextMetadata.dependencies,
      },
    },
    nextTaskContent,
  );

  return {
    graph,
    task: {
      file: task.file,
      content: nextTaskContent,
    },
  };
}

function cloneDependencyGraph(graph: DependencyGraph): DependencyGraph {
  return DependencyGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
}

function rebuildGraphEdges(graph: DependencyGraph): DependencyGraph["edges"] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  return graph.nodes.flatMap((node) =>
    node.depends_on.map((dependency) => ({
      from: dependency,
      to: node.id,
      reason: `${node.title} requires ${nodesById.get(dependency)?.title ?? dependency} to be complete.`,
    })),
  );
}

function dependsOn(graph: DependencyGraph, taskId: string, dependencyId: string): boolean {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const stack = [taskId];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current === dependencyId) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    stack.push(...(nodesById.get(current)?.depends_on ?? []));
  }

  return false;
}

function renderTaskMarkdown(content: string, metadata: BlueprintTaskMetadata): string {
  return `---\n${stringify(metadata)}---\n\n${content.trimStart()}`;
}

async function buildRevisionIndex(root: string): Promise<BlueprintRevisionIndex> {
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  const files = await readBlueprintFiles(blueprintRoot);
  const tasks = await readTaskFiles(blueprintRoot);
  const graph = await readGraph(blueprintRoot);

  return {
    blueprintRoot,
    files,
    tasks,
    graph,
  };
}

async function readBlueprintFiles(blueprintRoot: string): Promise<Array<{ file: string; content: string }>> {
  const existingFiles = await fg(DOC_FILES, {
    cwd: blueprintRoot,
    onlyFiles: true,
  });

  return Promise.all(
    existingFiles.map(async (file) => ({
      file,
      content: await readFile(path.join(blueprintRoot, file), "utf8"),
    })),
  );
}

async function readTaskFiles(blueprintRoot: string): Promise<BlueprintTaskIndexEntry[]> {
  const taskFiles = await fg(["tasks/*.md", "!tasks/README.md"], {
    cwd: blueprintRoot,
    onlyFiles: true,
  });

  return Promise.all(
    taskFiles.map(async (file) => {
      const raw = await readFile(path.join(blueprintRoot, file), "utf8");
      const parsed = matter(raw);

      return {
        id: String(parsed.data.id ?? path.basename(file, ".md")),
        file,
        metadata: parsed.data as BlueprintTaskMetadata,
        content: raw,
      };
    }),
  );
}

async function readGraph(blueprintRoot: string): Promise<DependencyGraph | undefined> {
  try {
    const raw = await readFile(path.join(blueprintRoot, "dependencies_graph.json"), "utf8");
    return DependencyGraphSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function scoreFiles(
  index: BlueprintRevisionIndex,
  tokens: string[],
  explicitPaths: string[],
): Array<{ file: string; score: number }> {
  return index.files
    .map(({ file, content }) => {
      const haystack = `${file}\n${content}`.toLowerCase();
      const explicitScore = explicitPaths.some((explicitPath) => pathMatches(file, explicitPath)) ? 12 : 0;
      const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);

      return {
        file,
        score: explicitScore + tokenScore,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
}

function scoreTasks(
  index: BlueprintRevisionIndex,
  tokens: string[],
  explicitPaths: string[],
  explicitTaskIds: string[],
): Array<{ task: BlueprintTaskIndexEntry; score: number }> {
  return index.tasks
    .map((task) => {
      const haystack = [
        task.id,
        task.file,
        task.metadata.title,
        task.metadata.suggested_model,
        ...(task.metadata.allowed_paths ?? []),
        ...(task.metadata.test_commands ?? []),
        task.content,
      ]
        .join("\n")
        .toLowerCase();
      const taskIdScore = explicitTaskIds.includes(task.id) ? 20 : 0;
      const pathScore = explicitPaths.some(
        (explicitPath) =>
          pathMatches(task.file, explicitPath) ||
          (task.metadata.allowed_paths ?? []).some((allowedPath) => pathMatches(allowedPath, explicitPath)),
      )
        ? 12
        : 0;
      const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
      const graphScore = index.graph?.nodes.some((node) => node.id === task.id && explicitTaskIds.includes(node.id))
        ? 3
        : 0;

      return {
        task,
        score: taskIdScore + pathScore + tokenScore + graphScore,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
}

function chooseRevisionClass(
  change: string,
  affectedFiles: string[],
  affectedTasks: string[],
  explicitPaths: string[],
  explicitTaskIds: string[],
): RevisionClass {
  const hasGlobalSignal = GLOBAL_REPLAN_PATTERNS.some((pattern) => pattern.test(change));
  const hasArchitectureSignal = ARCHITECTURE_PATTERNS.some((pattern) => pattern.test(change));
  const hasGraphSignal = GRAPH_PATTERNS.some((pattern) => pattern.test(change));
  const hasStrongGraphSignal = STRONG_GRAPH_PATTERNS.some((pattern) => pattern.test(change));
  const hasDocSignal = DOC_PATTERNS.some((pattern) => pattern.test(change));

  if (hasGlobalSignal && affectedTasks.length !== 1) {
    return "global_replan";
  }

  if (hasArchitectureSignal) {
    return hasGlobalSignal || affectedTasks.length > 2 ? "global_replan" : "architecture_subtree";
  }

  if (
    explicitTaskIds.length === 0 &&
    explicitPaths.some((explicitPath) => explicitPath.endsWith(".md") && !explicitPath.endsWith("dependencies_graph.json"))
  ) {
    return "local_doc";
  }

  if (explicitTaskIds.length === 1 && !hasStrongGraphSignal) {
    return "task_local";
  }

  if (hasDocSignal && explicitTaskIds.length === 0 && affectedFiles.some((file) => file.endsWith(".md"))) {
    return "local_doc";
  }

  if (hasGraphSignal || affectedTasks.length > 1) {
    return "graph_local";
  }

  if (affectedTasks.length === 1) {
    return "task_local";
  }

  if (hasDocSignal || affectedFiles.some((file) => file.endsWith(".md"))) {
    return "local_doc";
  }

  return affectedFiles.length > 1 ? "architecture_subtree" : "local_doc";
}

function selectAffectedFiles(scoredFiles: Array<{ file: string; score: number }>, explicitPaths: string[]): string[] {
  const scored = scoredFiles.slice(0, 5).map((entry) => entry.file);
  const explicit = explicitPaths.filter((explicitPath) => !explicitPath.includes("*"));

  return unique([...explicit, ...scored]);
}

function selectAffectedTasks(
  scoredTasks: Array<{ task: BlueprintTaskIndexEntry; score: number }>,
  explicitTaskIds: string[],
): string[] {
  return unique([...explicitTaskIds, ...scoredTasks.slice(0, 5).map((entry) => entry.task.id)]);
}

function refineAffectedTasks(
  classification: RevisionClass,
  affectedTasks: string[],
  explicitTaskIds: string[],
): string[] {
  if (classification === "local_doc" && explicitTaskIds.length === 0) {
    return [];
  }

  if (classification === "task_local" && explicitTaskIds.length === 1) {
    return explicitTaskIds;
  }

  return affectedTasks;
}

function refineAffectedFiles(
  index: BlueprintRevisionIndex,
  classification: RevisionClass,
  affectedFiles: string[],
  affectedTasks: string[],
  explicitPaths: string[],
): string[] {
  const explicitFiles = explicitPaths.filter((explicitPath) => !explicitPath.includes("*"));

  if (classification === "local_doc") {
    const managedDocFiles = new Set(index.files.map((file) => file.file).filter((file) => file.endsWith(".md")));
    const explicitManagedDocs = explicitFiles.filter((file) => managedDocFiles.has(file));

    if (explicitManagedDocs.length > 0) {
      return unique(explicitManagedDocs).slice(0, 5);
    }

    return unique([
      ...explicitFiles,
      ...affectedFiles.filter((file) => file.endsWith(".md") && !file.startsWith("tasks/")),
    ]).slice(0, 5);
  }

  const taskFiles = affectedTasks
    .map((taskId) => index.tasks.find((task) => task.id === taskId)?.file)
    .filter((file): file is string => Boolean(file));

  if (classification === "task_local") {
    return unique([...taskFiles, ...explicitFiles]).slice(0, 5);
  }

  return unique([...taskFiles, ...explicitFiles, ...affectedFiles]).slice(0, 8);
}

function buildRationale(
  change: string,
  affectedFiles: string[],
  affectedTasks: string[],
  classification: RevisionClass,
  explicitPaths: string[],
  explicitTaskIds: string[],
): string[] {
  const rationale = [`Classified as ${classification} using lexical Smart Grep heuristics.`];

  if (explicitPaths.length > 0) {
    rationale.push(`Detected explicit paths: ${explicitPaths.join(", ")}.`);
  }

  if (explicitTaskIds.length > 0) {
    rationale.push(`Detected explicit task ids: ${explicitTaskIds.join(", ")}.`);
  }

  if (affectedTasks.length > 0) {
    rationale.push(`Matched affected tasks: ${affectedTasks.join(", ")}.`);
  }

  if (affectedFiles.length > 0) {
    rationale.push(`Matched affected files: ${affectedFiles.join(", ")}.`);
  }

  if (ARCHITECTURE_PATTERNS.some((pattern) => pattern.test(change))) {
    rationale.push("Detected architecture or technology keyword.");
  }

  if (GLOBAL_REPLAN_PATTERNS.some((pattern) => pattern.test(change))) {
    rationale.push("Detected global replan keyword.");
  }

  return rationale;
}

function estimateConfidence(
  classification: RevisionClass,
  affectedFiles: string[],
  affectedTasks: string[],
  explicitPaths: string[],
  explicitTaskIds: string[],
): number {
  let confidence = 0.45;

  if (explicitPaths.length > 0 || explicitTaskIds.length > 0) {
    confidence += 0.25;
  }

  if (affectedFiles.length > 0) {
    confidence += 0.1;
  }

  if (affectedTasks.length > 0) {
    confidence += 0.15;
  }

  if (classification === "global_replan") {
    confidence -= 0.05;
  }

  return Number(Math.min(0.95, Math.max(0.2, confidence)).toFixed(2));
}

function recommendedAction(classification: RevisionClass): string {
  if (classification === "local_doc") {
    return "Rewrite the matched documentation artifact only, then run blueprint lint.";
  }

  if (classification === "task_local") {
    return "Rewrite the matched task file only, preserving task id and graph edges unless the model finds a hard blocker.";
  }

  if (classification === "graph_local") {
    return "Rewrite matched task files and dependencies_graph.json edges for directly affected nodes.";
  }

  if (classification === "architecture_subtree") {
    return "Replan the affected architecture subtree and regenerate only impacted tasks plus graph edges.";
  }

  return "Ask for confirmation before rerunning global planning because a central premise may have changed.";
}

async function writeRevisionPlan(blueprintRoot: string, plan: RevisionPlan): Promise<string> {
  const revisionsRoot = path.join(blueprintRoot, "revisions");
  const stamp = plan.created_at.replace(/[:.]/gu, "-");
  const targetPath = path.join(revisionsRoot, `${stamp}-${plan.classification}.json`);

  await mkdir(revisionsRoot, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return targetPath;
}

function extractTaskReferences(input: string, tasks: BlueprintTaskIndexEntry[]): string[] {
  const exact = input.match(/\btask-\d{3}-[a-z0-9-]+\b/giu)?.map((match) => match.toLowerCase()) ?? [];
  const numeric = input.match(/\btask[-\s]?(\d{3})\b/giu) ?? [];
  const numericMatches = numeric.flatMap((match) => {
    const number = /\d{3}/u.exec(match)?.[0];

    if (!number) {
      return [];
    }

    return tasks.filter((task) => task.id.startsWith(`task-${number}-`)).map((task) => task.id);
  });

  return unique([...exact, ...numericMatches]);
}

function extractOrderedTaskReferences(input: string, tasks: BlueprintTaskIndexEntry[]): string[] {
  const matches = input.matchAll(/\btask-\d{3}-[a-z0-9-]+\b|\btask[-\s]?(\d{3})\b/giu);
  const ordered: string[] = [];

  for (const match of matches) {
    const raw = match[0].toLowerCase();
    const id =
      raw.match(/\btask-\d{3}-[a-z0-9-]+\b/u)?.[0] ??
      tasks.find((task) => task.id.startsWith(`task-${match[1]}-`))?.id;

    if (id) {
      ordered.push(id);
    }
  }

  return unique(ordered);
}

function extractPathLikes(input: string): string[] {
  return unique(
    input.match(/(?:\.blueprint\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]+(?:\.[A-Za-z0-9]+)?|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/gu) ?? [],
  ).map((candidate) => candidate.replace(/^\.blueprint\//u, ""));
}

function normalizeSearchText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function tokenize(input: string): string[] {
  return unique(
    normalizeSearchText(input)
      .split(/[^a-z0-9_.-]+/u)
      .filter((token) => token.length >= 3),
  );
}

function pathMatches(candidate: string, explicitPath: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedPath = explicitPath.toLowerCase().replace(/^\.blueprint\//u, "");

  return (
    normalizedCandidate === normalizedPath ||
    normalizedCandidate.endsWith(normalizedPath) ||
    normalizedPath.includes(normalizedCandidate)
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function summarizeApplyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.replace(/\s+/gu, " ").trim();

  if (trimmed.length === 0) {
    return "Unknown apply error.";
  }

  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}
