import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

const cli = path.join(process.cwd(), "node_modules", ".bin", "tsx");

describe("blueprint cli", () => {
  it("honors --root for nested subcommands and the default TUI command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-cli-root-test-"));
    const dashboardRoot = await mkdtemp(path.join(os.tmpdir(), "blueprint-cli-dashboard-test-"));

    const init = await execa(cli, [
      "src/cli.ts",
      "profile",
      "init",
      "--root",
      root,
      "--providers",
      "openai,google",
      "--planner-provider",
      "openai",
      "--planner-model",
      "gpt-5.5",
      "--project-registry",
      "--force",
    ]);
    const profile = await readFile(path.join(root, ".blueprint", "profile.yaml"), "utf8");
    const dashboard = await execa(cli, ["src/cli.ts", "--root", dashboardRoot, "--json"]);

    expect(init.stdout).toContain(path.join(root, ".blueprint", "profile.yaml"));
    expect(profile).toContain("planner_model: gpt-5.5");
    expect(JSON.parse(dashboard.stdout).root).toBe(dashboardRoot);
  });
});
