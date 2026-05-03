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

export interface ProjectDoctorReport {
  root: string;
  canonicalFiles: string[];
  manifests: string[];
  fileCount: number;
  blockedPatterns: string[];
  warnings: string[];
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
    fileCount: visibleFiles.length,
    blockedPatterns: [...DEFAULT_IGNORES, ...SECRET_PATTERNS],
    warnings,
  };
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
