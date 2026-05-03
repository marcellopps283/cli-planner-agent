import { describe, expect, it } from "vitest";

import { DependencyGraphSchema } from "../src/schemas.js";

describe("DependencyGraphSchema", () => {
  it("accepts a minimal valid graph", () => {
    const graph = DependencyGraphSchema.parse({
      schema_version: "1.0",
      nodes: [
        {
          id: "task-001",
          title: "Create project scaffold",
          task_file: "tasks/001-create-project-scaffold.md",
          depends_on: [],
          allowed_paths: ["src/"],
          risk_level: 2,
        },
      ],
      edges: [],
      parallel_groups: {
        foundation: ["task-001"],
      },
    });

    expect(graph.nodes).toHaveLength(1);
  });
});
