import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { initBlueprint } from "../src/blueprint.js";
import { lintBlueprint } from "../src/lint.js";

describe("blueprint lifecycle", () => {
  it("initializes a lintable empty blueprint", async () => {
    const root = await makeTempProject();

    const written = await initBlueprint({ root });
    const result = await lintBlueprint(root);

    expect(written).toContain(".blueprint/blueprint.yaml");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("No task files found under .blueprint/tasks/.");
  });

  it("uses an existing profile when initializing the manifest", async () => {
    const root = await makeTempProject();
    await mkdir(path.join(root, ".blueprint"), { recursive: true });
    await writeFile(
      path.join(root, ".blueprint", "profile.yaml"),
      stringify({
        schema_version: "1.0",
        name: "default",
        planner_provider: "openai",
        planner_model: "gpt-5.5",
        available_providers: ["openai", "google"],
        excluded_providers: ["anthropic"],
      }),
      "utf8",
    );

    await initBlueprint({ root, force: true });
    const manifest = parseYaml(await readFile(path.join(root, ".blueprint", "blueprint.yaml"), "utf8"));

    expect(manifest.planner_provider).toBe("openai");
    expect(manifest.planner_model).toBe("gpt-5.5");
    expect(manifest.available_providers).toEqual(["openai", "google"]);
  });

  it("detects parallel write conflicts", async () => {
    const root = await makeTempProject();
    await initBlueprint({ root, force: true });
    await mkdir(path.join(root, ".blueprint", "tasks"), { recursive: true });

    await writeTask(root, "task-001", "tasks/001-one.md");
    await writeTask(root, "task-002", "tasks/002-two.md");

    await writeFile(
      path.join(root, ".blueprint", "dependencies_graph.json"),
      `${JSON.stringify(
        {
          schema_version: "1.0",
          nodes: [
            {
              id: "task-001",
              title: "One",
              task_file: "tasks/001-one.md",
              depends_on: [],
              allowed_paths: ["src/shared.ts"],
              risk_level: 2,
            },
            {
              id: "task-002",
              title: "Two",
              task_file: "tasks/002-two.md",
              depends_on: [],
              allowed_paths: ["src/shared.ts"],
              risk_level: 2,
            },
          ],
          edges: [],
          parallel_groups: {
            same_batch: ["task-001", "task-002"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await lintBlueprint(root);

    expect(result.errors).toContain(
      "parallel group same_batch has write conflict on src/shared.ts: task-001 and task-002.",
    );
  });

  it("warns about missing allowed paths and weak pnpm commands", async () => {
    const root = await makeTempProject();
    await initBlueprint({ root, force: true });
    await mkdir(path.join(root, ".blueprint", "tasks"), { recursive: true });
    await writeTask(root, "task-001", "tasks/001-one.md");

    const result = await lintBlueprint(root);

    expect(result.warnings).toContain(
      'tasks/001-one.md: allowed_path src/shared.ts does not exist yet; mention new files or directories explicitly in <context_rules> if intentional.',
    );
    expect(result.warnings).toContain(
      'tasks/001-one.md: test_command "pnpm test" should use "corepack pnpm ..." for reproducible local runs.',
    );
  });
});

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blueprint-test-"));
  await writeFile(path.join(root, "README.md"), "# Test project\n", "utf8");
  return root;
}

async function writeTask(root: string, id: string, relativePath: string): Promise<void> {
  const metadata = {
    id,
    title: id,
    suggested_model: "claude-opus-4-7",
    dependencies: [],
    parallel_group: "same_batch",
    allowed_paths: ["src/shared.ts"],
    forbidden_paths: [".env"],
    risk_level: 2,
    test_commands: ["pnpm test"],
  };

  const content = `---\n${stringify(metadata)}---\n\n<task_objective>\nDo the task.\n</task_objective>\n\n<suggested_model>\nclaude-opus-4-7\n</suggested_model>\n\n<context_rules>\nStay inside allowed paths.\n</context_rules>\n\n<execution_prompt>\nImplement the requested change.\n</execution_prompt>\n\n<acceptance_contract>\nTests pass.\n</acceptance_contract>\n`;

  await writeFile(path.join(root, ".blueprint", relativePath), content, "utf8");
}
