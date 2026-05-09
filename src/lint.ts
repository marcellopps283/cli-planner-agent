import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { PROFILE_FILE, loadPlannerProfile } from "./profile.js";
import {
  BlueprintManifestSchema,
  BlueprintTaskMetadataSchema,
  DependencyGraphSchema,
  type BlueprintTaskMetadata,
  type DependencyGraph,
} from "./schemas.js";

const REQUIRED_XML_BLOCKS = [
  "task_objective",
  "suggested_model",
  "context_rules",
  "execution_prompt",
  "acceptance_contract",
];

export interface BlueprintLintResult {
  root: string;
  errors: string[];
  warnings: string[];
}

export async function lintBlueprint(rootInput: string): Promise<BlueprintLintResult> {
  const root = path.resolve(rootInput);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  const errors: string[] = [];
  const warnings: string[] = [];

  await readAndValidateManifest(blueprintRoot, errors);
  await readAndValidateProfile(blueprintRoot, errors, warnings);
  const graph = await readAndValidateGraph(blueprintRoot, errors);
  const tasks = await readAndValidateTasks(blueprintRoot, errors, warnings);

  if (graph) {
    validateGraphReferences(blueprintRoot, graph, tasks, errors, warnings);
    validateParallelPathConflicts(graph, errors);
  }

  return { root, errors, warnings };
}

async function readAndValidateManifest(blueprintRoot: string, errors: string[]): Promise<void> {
  const manifestPath = path.join(blueprintRoot, "blueprint.yaml");

  try {
    const raw = await readFile(manifestPath, "utf8");
    BlueprintManifestSchema.parse(parseYaml(raw));
  } catch (error) {
    errors.push(formatValidationError("blueprint.yaml", error));
  }
}

async function readAndValidateProfile(
  blueprintRoot: string,
  errors: string[],
  warnings: string[],
): Promise<void> {
  const profilePath = path.join(blueprintRoot, PROFILE_FILE);

  try {
    await readFile(profilePath, "utf8");
    const result = await loadPlannerProfile(path.dirname(blueprintRoot));

    for (const error of result.errors) {
      errors.push(`${PROFILE_FILE}: ${error}`);
    }

    for (const warning of result.warnings) {
      warnings.push(`${PROFILE_FILE}: ${warning}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      errors.push(formatValidationError(PROFILE_FILE, error));
    }
  }
}

async function readAndValidateGraph(
  blueprintRoot: string,
  errors: string[],
): Promise<DependencyGraph | undefined> {
  const graphPath = path.join(blueprintRoot, "dependencies_graph.json");

  try {
    const raw = await readFile(graphPath, "utf8");
    return DependencyGraphSchema.parse(JSON.parse(raw)) as DependencyGraph;
  } catch (error) {
    errors.push(formatValidationError("dependencies_graph.json", error));
    return undefined;
  }
}

async function readAndValidateTasks(
  blueprintRoot: string,
  errors: string[],
  warnings: string[],
): Promise<Map<string, BlueprintTaskMetadata>> {
  const taskFiles = await fg(["tasks/*.md", "!tasks/README.md"], {
    cwd: blueprintRoot,
    onlyFiles: true,
  });
  const tasks = new Map<string, BlueprintTaskMetadata>();

  if (taskFiles.length === 0) {
    warnings.push("No task files found under .blueprint/tasks/.");
  }

  for (const taskFile of taskFiles) {
    const absolutePath = path.join(blueprintRoot, taskFile);
    const raw = await readFile(absolutePath, "utf8");
    const parsed = matter(raw);

    try {
      const metadata = BlueprintTaskMetadataSchema.parse(parsed.data);
      tasks.set(metadata.id, metadata);
      await validateTaskMetadata(path.dirname(blueprintRoot), taskFile, metadata, warnings);
    } catch (error) {
      errors.push(formatValidationError(taskFile, error));
    }

    for (const block of REQUIRED_XML_BLOCKS) {
      if (!hasXmlBlock(parsed.content, block)) {
        errors.push(`${taskFile}: missing <${block}> block.`);
      }
    }
  }

  return tasks;
}

async function validateTaskMetadata(
  projectRoot: string,
  taskFile: string,
  metadata: BlueprintTaskMetadata,
  warnings: string[],
): Promise<void> {
  for (const allowedPath of metadata.allowed_paths) {
    const existingBase = allowedPathExistingBase(allowedPath);

    if (!existingBase) {
      continue;
    }

    const absolutePath = path.resolve(projectRoot, existingBase);
    const relativePath = path.relative(projectRoot, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      warnings.push(`${taskFile}: allowed_path ${allowedPath} escapes the project root.`);
      continue;
    }

    try {
      await stat(absolutePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        warnings.push(
          `${taskFile}: allowed_path ${allowedPath} does not exist yet; mention new files or directories explicitly in <context_rules> if intentional.`,
        );
      } else {
        warnings.push(`${taskFile}: could not inspect allowed_path ${allowedPath}: ${String(error)}`);
      }
    }
  }

  for (const command of metadata.test_commands) {
    if (/^pnpm\s+/u.test(command)) {
      warnings.push(`${taskFile}: test_command "${command}" should use "corepack pnpm ..." for reproducible local runs.`);
    }

    if (/^(?:corepack\s+)?pnpm\s+test\s+run(?:\s|$)/u.test(command)) {
      warnings.push(`${taskFile}: test_command "${command}" should be "corepack pnpm test <file>" or "corepack pnpm vitest run <file>".`);
    }
  }
}

function allowedPathExistingBase(allowedPath: string): string | undefined {
  const trimmed = allowedPath.trim();

  if (!trimmed || trimmed.startsWith("!")) {
    return undefined;
  }

  const wildcardIndex = trimmed.search(/[*{[]/u);
  const base = wildcardIndex >= 0 ? trimmed.slice(0, wildcardIndex) : trimmed;
  const normalized = base.replace(/\/+$/u, "");

  if (!normalized || normalized === ".") {
    return undefined;
  }

  return normalized;
}

function validateGraphReferences(
  blueprintRoot: string,
  graph: DependencyGraph,
  tasks: Map<string, BlueprintTaskMetadata>,
  errors: string[],
  warnings: string[],
): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  for (const node of graph.nodes) {
    if (!tasks.has(node.id)) {
      errors.push(`dependencies_graph.json: node ${node.id} has no matching task frontmatter id.`);
    }

    const taskPath = path.join(blueprintRoot, node.task_file);
    if (!taskPath.startsWith(blueprintRoot)) {
      errors.push(`dependencies_graph.json: node ${node.id} task_file escapes .blueprint/.`);
    }

    for (const dependency of node.depends_on) {
      if (!nodeIds.has(dependency)) {
        errors.push(`dependencies_graph.json: node ${node.id} depends on unknown node ${dependency}.`);
      }
    }
  }

  for (const taskId of tasks.keys()) {
    if (!nodeIds.has(taskId)) {
      warnings.push(`Task ${taskId} is not referenced by dependencies_graph.json.`);
    }
  }
}

function validateParallelPathConflicts(graph: DependencyGraph, errors: string[]): void {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const [group, nodeIds] of Object.entries(graph.parallel_groups)) {
    const owners = new Map<string, string>();

    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId);

      if (!node) {
        errors.push(`parallel group ${group} references unknown node ${nodeId}.`);
        continue;
      }

      for (const allowedPath of node.allowed_paths) {
        const currentOwner = owners.get(allowedPath);

        if (currentOwner) {
          errors.push(
            `parallel group ${group} has write conflict on ${allowedPath}: ${currentOwner} and ${nodeId}.`,
          );
        } else {
          owners.set(allowedPath, nodeId);
        }
      }
    }
  }
}

function hasXmlBlock(content: string, tag: string): boolean {
  const pattern = new RegExp(`<${tag}>[\\s\\S]+?</${tag}>`, "u");
  return pattern.test(content);
}

function formatValidationError(scope: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    return `${scope}: ${z.prettifyError(error)}`;
  }

  if (error instanceof Error) {
    return `${scope}: ${error.message}`;
  }

  return `${scope}: ${String(error)}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
