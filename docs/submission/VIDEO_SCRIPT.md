# Demo Video Script

Target length: 90 to 120 seconds.

## 0:00 - Problem

AI coding agents are powerful, but large projects fail when the first prompt is vague. Developers need a planning harness that asks the right questions, chooses the right model per subtask, and produces artifacts workers can execute.

## 0:15 - Product

This is Blueprint Planner-Agent. It is a terminal AI harness for planning software work before execution.

Show:

```bash
blueprint
```

Explain that the app starts in one interface, detects the project, configures providers, models, and reasoning settings, then opens a chat-like planning flow.

## 0:35 - Planning Flow

Type a short project idea in the chat. Show the planner asking for missing constraints instead of locking framework choices too early.

Key line:

Blueprint treats planning as a conversation first, then a formal handoff only after the scope is ready.

## 0:55 - Model Routing

Show model pool and preview.

Key line:

Blueprint routes by exact model, not by provider. It avoids sending cheap tasks to expensive models and avoids assigning weak models to architecture, security, or high-risk work.

## 1:15 - Artifacts

Run or show:

```bash
blueprint plan --answers tests/fixtures/plan-answers.cli.json --engine deterministic --yes --force
blueprint lint
```

Show `.blueprint/`:

- `architecture.md`
- `dependencies_graph.json`
- `integration_guide.md`
- `tasks/*.md`

Open one task and show:

- `suggested_model`
- `allowed_paths`
- XML blocks
- acceptance contract

## 1:40 - Close

Blueprint is the planning and orchestration brain for multi-model AI development. Version 1 generates rigorous handoffs for human-controlled workers; version 2 can become the supervisor that runs those workers from the same terminal harness.

## Recording Checklist

- Terminal font large enough to read.
- Start with clean repo and public GitHub URL visible once.
- Show the generated files, not only the chat UI.
- Keep the final video link ready for LabLab submission.
