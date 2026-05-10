# AI Video Prompt

Use this file as the main prompt for an AI video generator. Attach the three
reference images in `docs/submission/video_refs/` in this order:

1. `01-agent-harness.png`
2. `02-planning-chat.png`
3. `03-handoff-artifacts.png`

## Goal

Create a polished 90-120 second product demo video for **Blueprint
Planner-Agent**, a terminal AI planning harness for the AMD Developer Hackathon
AI Agents & Agentic Workflows track.

The video should feel like a modern developer-tool launch video: dark terminal
UI, precise motion, crisp typography, subtle code/workflow visuals, and no
cartoon style. It should explain the product clearly to judges who may not run a
CLI during first review.

## Product Truths

Do show:

- Blueprint is a CLI/TUI for planning software projects with AI.
- It starts as a chat-like planning harness.
- It asks clarifying questions before locking architecture decisions.
- It uses a selected pool of models from OpenAI/Codex, Claude Code, and Gemini
  CLI.
- It routes each task to an exact suggested model using risk, fit, cost,
  context, and reasoning effort.
- It generates `.blueprint/` artifacts: `architecture.md`,
  `dependencies_graph.json`, `integration_guide.md`, and `tasks/*.md`.
- Each task contains `suggested_model`, allowed paths, XML prompt blocks, and an
  acceptance contract.
- Version 1 generates handoffs for human-controlled workers.
- Version 2 is planned as a supervisor that can run workers directly.

Do not show or claim:

- Do not claim Blueprint currently executes worker agents automatically.
- Do not claim it fine-tunes models.
- Do not claim it ran on AMD GPUs or ROCm unless the video says it is submitted
  under the AI Agents track.
- Do not show fake private API keys, cookies, or secrets.
- Do not invent a web dashboard. The product is terminal-first.

## Visual Direction

- Format: 16:9 landscape.
- Style: premium terminal developer tool, close to OpenCode/Codex/Claude Code
  aesthetics.
- Palette: near-black background, cyan highlights, soft blue accents, restrained
  amber for warnings/preview.
- Motion: smooth camera pans, terminal panels sliding in, dependency graph lines
  drawing, generated files appearing one by one.
- Text must be large and readable. Avoid tiny unreadable terminal spam.
- Use the attached images as style and layout references, not as exact static
  screenshots.

## Voiceover

Use a calm, confident English voiceover. Keep the rhythm fast but readable.

### Scene 1 - The Problem, 0:00-0:15

Visual: Start from reference image 1. Show a dark terminal surface with an empty
planning prompt. Behind it, show faint fragmented tasks and model names drifting
out of order.

Voiceover:

> AI coding agents are powerful, but large projects fail when the first prompt
> is vague. Teams need a planning layer before execution.

On-screen text:

```text
Vague prompt -> scattered agent work
```

### Scene 2 - The Product, 0:15-0:30

Visual: The terminal resolves into Blueprint. Show the command:

```bash
blueprint
```

Then show a clean single terminal interface with project, providers, models, and
planner status.

Voiceover:

> Blueprint Planner-Agent is a terminal AI harness that turns a project idea
> into a structured execution plan for coding agents.

On-screen text:

```text
Blueprint Planner-Agent
Plan first. Route smarter. Ship with agents.
```

### Scene 3 - Planning Chat, 0:30-0:52

Visual: Use reference image 2. Show the user typing a project idea. The planner
responds with clarifying questions instead of immediately choosing a framework.
Animate checklist items such as `scope`, `constraints`, `validation`, and
`provider pool`.

Voiceover:

> The workflow starts as a conversation. Blueprint helps brainstorm the product,
> finds missing requirements, and avoids locking framework choices too early.

On-screen text:

```text
Brainstorm -> clarify -> confirm
```

### Scene 4 - Model Routing, 0:52-1:12

Visual: Show three provider columns: OpenAI/Codex, Claude Code, Gemini CLI. Then
zoom into exact model IDs and reasoning effort. Draw arrows from task cards to
model cards.

Voiceover:

> Before writing handoffs, Blueprint routes each subtask to an exact model. It
> balances risk, context, cost, latency, fit, and reasoning effort so small tasks
> do not waste premium models, and high-risk work is not assigned to weak ones.

On-screen text:

```text
Task -> exact model -> rationale
```

### Scene 5 - Handoff Artifacts, 1:12-1:40

Visual: Use reference image 3. Show `.blueprint/` being generated. Open one task
file and highlight:

```yaml
suggested_model: gpt-5.5
allowed_paths:
  - src/plan.ts
```

Then highlight XML blocks:

```xml
<task_objective>
<context_rules>
<execution_prompt>
<acceptance_contract>
```

Voiceover:

> The output is not a loose chat summary. Blueprint writes versionable artifacts:
> architecture notes, a dependency graph, an integration guide, and isolated XML
> task prompts that another coding agent can execute.

On-screen text:

```text
.blueprint/
  architecture.md
  dependencies_graph.json
  integration_guide.md
  tasks/*.md
```

### Scene 6 - Close, 1:40-1:55

Visual: Return to the hero terminal. Show the generated graph, task list, and
public repository URL.

Voiceover:

> Blueprint is the planning and orchestration brain for multi-model AI
> development. Version one generates rigorous handoffs. Version two can become
> the supervisor that runs the workers from the same terminal.

On-screen text:

```text
GitHub: github.com/marcellopps283/cli-planner-agent
Demo: marcellopps283.github.io/cli-planner-agent
```

## Final Video Requirements

- Duration: 90-120 seconds.
- Resolution: 1920x1080 preferred.
- Include readable on-screen text.
- Include the GitHub URL and demo URL near the end.
- Keep the product terminal-first.
- Make the result feel like a serious developer tool, not a generic AI promo.
