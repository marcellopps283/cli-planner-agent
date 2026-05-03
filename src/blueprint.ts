import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify } from "yaml";

import { PlannerProfileSchema, type BlueprintManifest, type DependencyGraph, type PlannerProfile } from "./schemas.js";

export const BLUEPRINT_DIR = ".blueprint";

export interface InitBlueprintOptions {
  root: string;
  force?: boolean;
}

interface TemplateFile {
  relativePath: string;
  content: string;
}

export async function initBlueprint(options: InitBlueprintOptions): Promise<string[]> {
  const root = path.resolve(options.root);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  const projectName = path.basename(root);

  await mkdir(path.join(blueprintRoot, "tasks"), { recursive: true });
  const profile = await readExistingProfile(blueprintRoot);

  const manifest: BlueprintManifest = {
    schema_version: "1.0",
    project_name: projectName,
    created_at: new Date().toISOString(),
    planner_provider: profile?.planner_provider ?? "anthropic",
    planner_model: profile?.planner_model ?? "claude-opus-4-7",
    available_providers: profile?.available_providers ?? ["openai", "anthropic", "google"],
    available_models: profile?.available_models ?? [],
    artifact_root: ".blueprint",
    status: "draft",
  };

  const graph: DependencyGraph = {
    schema_version: "1.0",
    nodes: [],
    edges: [],
    parallel_groups: {},
  };

  const files: TemplateFile[] = [
    {
      relativePath: "blueprint.yaml",
      content: stringify(manifest),
    },
    {
      relativePath: "architecture.md",
      content: `# Architecture\n\nTBD by \`blueprint plan\`.\n`,
    },
    {
      relativePath: "assumptions.md",
      content: `# Assumptions\n\n- TBD by \`blueprint plan\`.\n`,
    },
    {
      relativePath: "decisions.md",
      content: `# Decisions\n\n- TBD by \`blueprint plan\`.\n`,
    },
    {
      relativePath: "risks.md",
      content: `# Risks\n\n- TBD by \`blueprint plan\`.\n`,
    },
    {
      relativePath: "dependencies_graph.json",
      content: `${JSON.stringify(graph, null, 2)}\n`,
    },
    {
      relativePath: "integration_guide.md",
      content: `# Integration Guide\n\nTBD by \`blueprint plan\`.\n`,
    },
    {
      relativePath: "tasks/README.md",
      content: `# Tasks\n\nGenerated task handoffs live here.\n`,
    },
  ];

  const written: string[] = [];

  for (const file of files) {
    const absolutePath = path.join(blueprintRoot, file.relativePath);
    const didWrite = await writeFileIfAllowed(absolutePath, file.content, Boolean(options.force));

    if (didWrite) {
      written.push(path.relative(root, absolutePath));
    }
  }

  return written;
}

async function readExistingProfile(blueprintRoot: string): Promise<PlannerProfile | undefined> {
  try {
    const raw = await readFile(path.join(blueprintRoot, "profile.yaml"), "utf8");
    return PlannerProfileSchema.parse(parseYaml(raw));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function writeFileIfAllowed(filePath: string, content: string, force: boolean): Promise<boolean> {
  if (!force) {
    try {
      await readFile(filePath, "utf8");
      return false;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return true;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
