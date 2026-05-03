import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { BLUEPRINT_DIR } from "./blueprint.js";
import { lintBlueprint } from "./lint.js";
import { BlueprintManifestSchema } from "./schemas.js";

export const ExportManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  created_at: z.iso.datetime(),
  source_project: z.string().min(1),
  source_blueprint: z.string().min(1),
  lint_warnings: z.array(z.string()),
  included_files: z.array(z.string()),
  excluded_files: z.array(z.string()),
});

export type ExportManifest = z.infer<typeof ExportManifestSchema>;

export interface ExportBlueprintOptions {
  root: string;
  out?: string;
  force?: boolean;
  includeRevisions?: boolean;
  includeProfile?: boolean;
  allowInvalid?: boolean;
}

export interface ExportBlueprintResult {
  root: string;
  outputPath: string;
  manifestPath: string;
  manifest: ExportManifest;
}

const EXPORT_MANIFEST_FILE = "EXPORT_MANIFEST.json";
const DEFAULT_INCLUDE_PATTERNS = [
  "blueprint.yaml",
  "architecture.md",
  "assumptions.md",
  "decisions.md",
  "risks.md",
  "dependencies_graph.json",
  "integration_guide.md",
  "model_registry.yaml",
  "tasks/*.md",
];

const ALWAYS_EXCLUDED_PATTERNS = ["exports/**", "tui_sessions/**"];

export async function exportBlueprint(options: ExportBlueprintOptions): Promise<ExportBlueprintResult> {
  const root = path.resolve(options.root);
  const blueprintRoot = path.join(root, BLUEPRINT_DIR);
  const lint = await lintBlueprint(root);

  if (lint.errors.length > 0 && !options.allowInvalid) {
    throw new Error(`Blueprint lint failed. Run blueprint lint or pass --allow-invalid.\n${lint.errors.join("\n")}`);
  }

  const projectName = await readProjectName(blueprintRoot, root);
  const outputPath = path.resolve(options.out ?? path.join(blueprintRoot, "exports", defaultExportName(projectName)));
  const files = await selectExportFiles(blueprintRoot, {
    includeRevisions: options.includeRevisions,
    includeProfile: options.includeProfile,
  });

  await prepareOutputPath(outputPath, options.force);

  for (const file of files.included) {
    const source = path.join(blueprintRoot, file);
    const target = path.join(outputPath, file);

    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }

  const manifest = ExportManifestSchema.parse({
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    source_project: projectName,
    source_blueprint: path.relative(root, blueprintRoot),
    lint_warnings: lint.warnings,
    included_files: files.included,
    excluded_files: files.excluded,
  });
  const manifestPath = path.join(outputPath, EXPORT_MANIFEST_FILE);

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    root,
    outputPath,
    manifestPath,
    manifest,
  };
}

async function readProjectName(blueprintRoot: string, root: string): Promise<string> {
  const raw = await readFile(path.join(blueprintRoot, "blueprint.yaml"), "utf8");
  const manifest = BlueprintManifestSchema.parse(parseYaml(raw));

  return manifest.project_name || path.basename(root);
}

async function selectExportFiles(
  blueprintRoot: string,
  options: { includeRevisions?: boolean; includeProfile?: boolean },
): Promise<{ included: string[]; excluded: string[] }> {
  const allFiles = await fg(["**/*"], {
    cwd: blueprintRoot,
    onlyFiles: true,
    dot: true,
    ignore: ALWAYS_EXCLUDED_PATTERNS,
  });
  const alwaysExcludedFiles = await fg(ALWAYS_EXCLUDED_PATTERNS, {
    cwd: blueprintRoot,
    onlyFiles: true,
    dot: true,
  });
  const includePatterns = [
    ...DEFAULT_INCLUDE_PATTERNS,
    ...(options.includeRevisions ? ["revisions/*.json"] : []),
    ...(options.includeProfile ? ["profile.yaml"] : []),
  ];
  const included = await fg(includePatterns, {
    cwd: blueprintRoot,
    onlyFiles: true,
    dot: true,
    ignore: ALWAYS_EXCLUDED_PATTERNS,
  });
  const includedSet = new Set(included);
  const excluded = [
    ...allFiles.filter((file) => !includedSet.has(file)),
    ...(alwaysExcludedFiles.length > 0 ? ALWAYS_EXCLUDED_PATTERNS : []),
  ];

  return {
    included: included.sort(),
    excluded: unique(excluded).sort(),
  };
}

async function prepareOutputPath(outputPath: string, force: boolean | undefined): Promise<void> {
  if (force) {
    await rm(outputPath, { recursive: true, force: true });
  } else if (await pathExists(outputPath)) {
    throw new Error(`Export output already exists: ${outputPath}. Use --force to overwrite it.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(outputPath, { recursive: false });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function defaultExportName(projectName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const safeProject = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return `${safeProject || "project"}-blueprint-${stamp}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
