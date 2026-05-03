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
});
