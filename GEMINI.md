# Project Guidelines for Gemini

## 1. Project Context
This is `cli-planner-agent`, a TypeScript CLI/TUI built with React and Ink that acts as a planning harness for AI workflows. The output artifacts are saved in `.blueprint/`.

## 2. Core Operational Mandates
- **Package Manager:** Use `corepack pnpm` for all commands (`pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm check`).
- **Architectural Rules:** Always respect decisions in `docs/DESIGN_LOCK.md` and `docs/MVP_ROADMAP.md`. Structural changes require an ADR.
- **Security:** Do not capture cookies or session tokens. Rely exclusively on official CLI auth bridges (`codex`, `claude`, `gemini`). Never log or output secrets.
- **Testing:** Write Vitest tests (`*.test.ts`) alongside the code. Ensure `pnpm check` passes before concluding tasks. Generated `.blueprint/` fixtures must remain valid according to schemas.

## 3. Frontend / TUI Architecture (OpenCode Model)
- The frontend must follow the OpenCode-inspired specification (`docs/SPECS/opencode_tui_reference.md`).
- **Layout Flow:**
  1. **Start Screen:** Centered prompt input, active provider/model, and hints.
  2. **Workbench:** Transitions upon the first message. Features a persistent Sidebar (Context, MCP, Todo) and a main Chat Feed with bottom input.
- **Refactoring Rule:** Do not add logic to the monolithic `src/tui.ts`. Extract features into `src/ui/` components (e.g., `StartScreen`, `Workbench`, `Sidebar`, `ChatFeed`). Maintain clean separation of state and presentation.

## 4. Code Conventions
- Use TypeScript ES Modules.
- Prefer explicit logic over clever hacks.
- Rely on Zod for validations and external contracts.
- Use 2-space indentation and semicolons.
- Use lowercase nouns for module names.