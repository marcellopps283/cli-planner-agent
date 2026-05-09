import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectProject } from "../src/doctor.js";

describe("project doctor", () => {
  it("ignores inaccessible directories during context inventory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-doctor-test-"));
    const privateDir = path.join(root, "private");

    await writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
    await mkdir(privateDir);
    await chmod(privateDir, 0o000);

    try {
      const report = await inspectProject(root);

      expect(report.canonicalFiles).toContain("README.md");
      expect(report.warnings).not.toContain("No canonical project docs were found.");
    } finally {
      await chmod(privateDir, 0o700);
    }
  });

  it("summarizes stack, scripts, top-level dirs, files, and markdown headings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-doctor-summary-test-"));

    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "README.md"), "# Test\n\n## Usage\n", "utf8");
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(root, "tests", "index.test.ts"), "import '../src/index';\n", "utf8");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          scripts: {
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(root, "tsconfig.json"), "{}", "utf8");

    const report = await inspectProject(root);

    expect(report.stack).toEqual(["node", "typescript"]);
    expect(report.scripts).toEqual({
      test: "vitest run",
      typecheck: "tsc --noEmit",
    });
    expect(report.topLevelDirs).toEqual(["src", "tests"]);
    expect(report.inventoryFiles.some((file) => file.path === "src/index.ts" && file.markers.includes("source"))).toBe(
      true,
    );
    expect(report.markdownHeadings["README.md"]).toEqual(["Test", "Usage"]);
  });

  it("ignores nested dependency directories when scanning broad roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-doctor-nested-deps-test-"));

    await mkdir(path.join(root, "packages", "app", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(root, "packages", "app", "package.json"), "{\"name\":\"app\"}\n", "utf8");
    await writeFile(path.join(root, "packages", "app", "node_modules", "dep", "package.json"), "{\"name\":\"dep\"}\n", "utf8");

    const report = await inspectProject(root);

    expect(report.manifests).toContain("packages/app/package.json");
    expect(report.manifests).not.toContain("packages/app/node_modules/dep/package.json");
  });
});
