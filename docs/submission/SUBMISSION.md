# Hackathon Submission Kit

## Project Title

Blueprint Planner-Agent

## Short Description

A terminal AI planning harness that turns vague software ideas into model-routed handoffs for coding agents.

## Long Description

Blueprint is a CLI/TUI for developers who use multiple AI coding tools but need a stronger planning layer before execution. It opens as a terminal agent harness, onboards the project directory, provider CLIs, model pool, and reasoning settings, then runs an investigative planning chat with the user.

When the scope is clear, Blueprint generates a technical blueprint under `.blueprint/`: architecture notes, assumptions, risks, a strict dependency graph, integration guidance, and isolated task files with XML prompts. Each task includes a precise `suggested_model`, allowed paths, validation commands, acceptance criteria, and context rules, so the user can hand it to Codex, Claude Code, Gemini CLI, or another worker without relying on chat memory.

The core value is avoiding both overfitting and underfitting in AI-assisted development. Blueprint routes work by exact model, not just provider, using a local model registry with task fit, context, cost, latency, reasoning effort, and risk rules. The MVP does not execute workers; it is the planning and orchestration brain. A future supervisor mode can run the workers directly from the same interface.

## Track

AI Agents & Agentic Workflows

## Technology Tags

- TypeScript
- Node.js
- CLI
- TUI
- Ink
- React
- Commander
- Vitest
- Zod
- YAML
- AI Agents
- Agentic Workflows
- Developer Tools
- LLM Routing
- Model Selection
- Prompt Engineering
- OpenAI Codex CLI
- Claude Code CLI
- Gemini CLI
- GitHub Pages

## Links

- GitHub repository: <https://github.com/marcellopps283/cli-planner-agent>
- Demo page: <https://marcellopps283.github.io/cli-planner-agent/>
- Cover image: <https://marcellopps283.github.io/cli-planner-agent/submission/cover.png>
- Video: `TODO: upload final demo video and paste link`

## Demo Commands

```bash
git clone https://github.com/marcellopps283/cli-planner-agent.git
cd cli-planner-agent
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev
```

For a deterministic artifact demo:

```bash
corepack pnpm dev profile init --providers openai,google --planner-provider openai --planner-model gpt-5.5 --force
corepack pnpm dev plan --answers tests/fixtures/plan-answers.cli.json --engine deterministic --yes --force
corepack pnpm dev lint
corepack pnpm dev export --json
```

## Judge-Facing Notes

- The demo app is a terminal-native product, so the public web demo is a landing page and installation guide.
- Provider calls run through official local CLIs; no browser cookie capture or unofficial session scraping is used.
- AMD/ROCm are hackathon context, not claimed as runtime technology unless a separate GPU workload is added before final submission.
