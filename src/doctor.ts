import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";
import ignore from "ignore";

const CANONICAL_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "docs/DESIGN_LOCK.md",
  "docs/MVP_ROADMAP.md",
  "docs/OPERATIONAL_SOURCES.md",
];

const DEFAULT_IGNORES = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".turbo/**",
  ".cache/**",
  ".next/**",
  ".venv/**",
  "__pycache__/**",
];

const SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "*.p12",
  "*.pfx",
];

const INVENTORY_FILE_LIMIT = 80;

export interface ProjectDoctorReport {
  root: string;
  canonicalFiles: string[];
  manifests: string[];
  stack: string[];
  scripts: Record<string, string>;
  topLevelDirs: string[];
  inventoryFiles: ProjectInventoryFile[];
  markdownHeadings: Record<string, string[]>;
  fileCount: number;
  blockedPatterns: string[];
  warnings: string[];
}

export interface ProjectInventoryFile {
  path: string;
  extension: string;
  sizeBytes: number;
  markers: string[];
}

export async function inspectProject(rootInput: string): Promise<ProjectDoctorReport> {
  const root = path.resolve(rootInput);
  const gitignore = await readGitignore(root);
  const matcher = ignore().add(DEFAULT_IGNORES).add(gitignore);

  const allFiles = await fg(["**/*"], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
    unique: true,
    ignore: DEFAULT_IGNORES,
  });

  const visibleFiles = allFiles.filter((file) => !matcher.ignores(file));
  const canonicalFiles = CANONICAL_FILES.filter((file) => visibleFiles.includes(file));
  const manifests = visibleFiles.filter((file) =>
    ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pnpm-lock.yaml", "uv.lock"].includes(
      path.basename(file),
    ),
  );
  const stack = inferStack(visibleFiles, manifests);
  const scripts = await readPackageScripts(root, visibleFiles);
  const topLevelDirs = inferTopLevelDirs(visibleFiles);
  const inventoryFiles = await summarizeInventoryFiles(root, visibleFiles, canonicalFiles, manifests);
  const markdownHeadings = await readMarkdownHeadings(root, canonicalFiles);

  const warnings: string[] = [];

  if (!canonicalFiles.includes("README.md")) {
    warnings.push("README.md not found.");
  }

  if (canonicalFiles.length === 0) {
    warnings.push("No canonical project docs were found.");
  }

  const hasGitDir = await directoryExists(path.join(root, ".git"));

  if (!hasGitDir) {
    warnings.push("No .git directory found. This may not be a project root.");
  }

  if (visibleFiles.length > 10_000) {
    warnings.push(
      `${visibleFiles.length.toLocaleString()} files detected. This directory looks too large — use --root to target a project.`,
    );
  }

  return {
    root,
    canonicalFiles,
    manifests,
    stack,
    scripts,
    topLevelDirs,
    inventoryFiles,
    markdownHeadings,
    fileCount: visibleFiles.length,
    blockedPatterns: [...DEFAULT_IGNORES, ...SECRET_PATTERNS],
    warnings,
  };
}

function inferStack(visibleFiles: string[], manifests: string[]): string[] {
  const fileSet = new Set(visibleFiles);
  const stack = new Set<string>();

  if (manifests.some((manifest) => path.basename(manifest) === "package.json")) {
    stack.add("node");
  }

  if (fileSet.has("tsconfig.json") || visibleFiles.some((file) => /\.(ts|tsx)$/u.test(file))) {
    stack.add("typescript");
  }

  if (visibleFiles.some((file) => /\.(js|jsx|mjs|cjs)$/u.test(file))) {
    stack.add("javascript");
  }

  if (manifests.some((manifest) => ["pyproject.toml", "uv.lock"].includes(path.basename(manifest)))) {
    stack.add("python");
  }

  if (manifests.some((manifest) => path.basename(manifest) === "Cargo.toml")) {
    stack.add("rust");
  }

  if (manifests.some((manifest) => path.basename(manifest) === "go.mod")) {
    stack.add("go");
  }

  if (fileSet.has("vite.config.ts") || fileSet.has("vite.config.js")) {
    stack.add("vite");
  }

  if (fileSet.has("next.config.js") || fileSet.has("next.config.ts") || fileSet.has("next.config.mjs")) {
    stack.add("nextjs");
  }

  if (visibleFiles.some((file) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/u.test(file))) {
    stack.add("docker");
  }

  if (visibleFiles.some((file) => /\.tf$/u.test(file))) {
    stack.add("terraform");
  }

  return [...stack].sort();
}

async function readPackageScripts(root: string, visibleFiles: string[]): Promise<Record<string, string>> {
  if (!visibleFiles.includes("package.json")) {
    return {};
  }

  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const scripts = (parsed as { scripts?: unknown }).scripts;

    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  } catch {
    return {};
  }
}

function inferTopLevelDirs(visibleFiles: string[]): string[] {
  const dirs = visibleFiles
    .filter((file) => file.includes("/"))
    .map((file) => file.split("/")[0])
    .filter((segment): segment is string => Boolean(segment));

  return [...new Set(dirs)]
    .sort()
    .slice(0, 24);
}

async function summarizeInventoryFiles(
  root: string,
  visibleFiles: string[],
  canonicalFiles: string[],
  manifests: string[],
): Promise<ProjectInventoryFile[]> {
  const canonical = new Set(canonicalFiles);
  const manifestSet = new Set(manifests);
  const selected = [...visibleFiles]
    .sort((left, right) => rankInventoryFile(left, canonical, manifestSet) - rankInventoryFile(right, canonical, manifestSet))
    .slice(0, INVENTORY_FILE_LIMIT);
  const summaries = await Promise.all(
    selected.map(async (file) => ({
      path: file,
      extension: path.extname(file).replace(/^\./u, "") || "none",
      sizeBytes: await fileSize(path.join(root, file)),
      markers: markersForFile(file, canonical, manifestSet),
    })),
  );

  return summaries.sort((left, right) => left.path.localeCompare(right.path));
}

function rankInventoryFile(file: string, canonical: Set<string>, manifests: Set<string>): number {
  if (canonical.has(file)) {
    return 0;
  }

  if (manifests.has(file)) {
    return 1;
  }

  if (/^(src|app|lib|tests?|spec|docs)\//u.test(file)) {
    return 2;
  }

  if (/config|schema|route|api|service|store|model|test|spec/iu.test(file)) {
    return 3;
  }

  return 10;
}

function markersForFile(file: string, canonical: Set<string>, manifests: Set<string>): string[] {
  const markers: string[] = [];

  if (canonical.has(file)) markers.push("canonical");
  if (manifests.has(file)) markers.push("manifest");
  if (/^(src|app|lib)\//u.test(file)) markers.push("source");
  if (/^(tests?|spec)\//u.test(file) || /\.(test|spec)\./u.test(file)) markers.push("test");
  if (/^docs\//u.test(file) || /\.md$/u.test(file)) markers.push("docs");
  if (/config|schema|route|api|service|store|model/iu.test(file)) markers.push("contract");

  return markers;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function readMarkdownHeadings(root: string, canonicalFiles: string[]): Promise<Record<string, string[]>> {
  const headings: Record<string, string[]> = {};

  for (const file of canonicalFiles.filter((candidate) => candidate.endsWith(".md"))) {
    try {
      const content = await readFile(path.join(root, file), "utf8");
      const fileHeadings = content
        .split(/\r?\n/u)
        .map((line) => /^#{1,3}\s+(.+)$/u.exec(line)?.[1]?.trim())
        .filter((heading): heading is string => Boolean(heading))
        .slice(0, 12);

      if (fileHeadings.length > 0) {
        headings[file] = fileHeadings;
      }
    } catch {
      // Ignore unreadable markdown docs; the doctor report already works without headings.
    }
  }

  return headings;
}


async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(dirPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function readGitignore(root: string): Promise<string[]> {
  try {
    const content = await readFile(path.join(root, ".gitignore"), "utf8");
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
