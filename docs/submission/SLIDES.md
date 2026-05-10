# Blueprint Planner-Agent Pitch Deck

Use this as the source copy for the hackathon pitch deck. The public HTML deck
is `pitch_deck.html`; the editable slide file is
`Blueprint-Planner-Agent-Pitch-Deck.pptx`.

## Slide 1 - Blueprint Planner-Agent

Terminal AI planning harness for multi-model coding workflows.

**Tagline:** Plan first. Route smarter. Ship with agents.

Blueprint turns vague software ideas into dependency graphs, model-routed
handoffs, and validation contracts for coding agents.

## Slide 2 - The Problem

AI coding agents execute quickly, but large projects still fail when the first
prompt is vague.

- Context drifts across chats and tools.
- Tasks overlap or miss dependencies.
- Expensive models get used for cheap work.
- Weak models get assigned to high-risk architecture.
- Final output is hard to audit before code changes begin.

## Slide 3 - The Solution

Blueprint is the planning and orchestration brain before worker agents start
changing code.

- Runs as a terminal-first CLI/TUI.
- Starts with an investigative planning chat.
- Reads compact project context instead of dumping the whole repo.
- Builds a strict dependency graph.
- Assigns exact models to exact tasks.
- Generates `.blueprint/` handoffs that workers can execute.

## Slide 4 - Agentic Workflow

1. Onboard project, providers, models, and reasoning effort.
2. Brainstorm with the user until product, constraints, validation, and scope are
   clear.
3. Preview task graph and model assignments.
4. Ask for confirmation.
5. Generate architecture docs, task XML, dependency graph, and integration guide.

The app behaves like an AI harness: one terminal surface, chat for planning,
operational panels for configuration and metrics.

## Slide 5 - Model Routing

Blueprint routes by **model**, not just provider.

Routing considers:

- task fit
- risk level
- context window
- reasoning effort
- cost class
- latency class
- provider availability

This avoids both overfitting and underfitting: small tasks do not waste premium
models, and high-risk work is not assigned to weak ones.

## Slide 6 - Generated Artifacts

Blueprint writes versionable handoffs under `.blueprint/`.

- `architecture.md`
- `dependencies_graph.json`
- `integration_guide.md`
- `assumptions.md`
- `risks.md`
- `tasks/*.md`

Each task includes `suggested_model`, allowed paths, forbidden paths,
dependencies, test commands, XML prompt blocks, and an acceptance contract.

## Slide 7 - What Works Now

MVP 1.0 is implemented as a planner-only agent harness.

- Public GitHub repo.
- TypeScript CLI/TUI.
- Provider registry and model pool.
- OpenAI/Codex, Claude Code, and Gemini CLI integration paths.
- Deterministic and LLM planning engines.
- Handoff linting, export, and smart revise.
- CI passing with 111 tests.
- Public demo/landing page on GitHub Pages.

## Slide 8 - Roadmap

MVP 1.0 plans and generates rigorous handoffs for human-controlled workers.

Version 2.0 turns Blueprint into a supervisor:

- run workers from the same terminal harness;
- track worker status, failures, and integration;
- coordinate Codex, Claude Code, Gemini CLI, and future tools;
- keep the developer in one operational surface.

**Vision:** the single terminal cockpit for planning, routing, and supervising
AI-assisted software development.
