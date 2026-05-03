# CLI Planner-Agent

> Nome provisorio. O produto final ainda precisa de naming antes de publicacao.

CLI para planejar projetos de software com modelos LLM ja autenticados pelo usuario.
O MVP e um planner puro: conversa com o usuario, entende o repo, quebra o escopo
em um grafo de tarefas e gera artefatos de handoff para execucao manual em agentes
como Codex, Claude Code e Gemini CLI.

## Status

Projeto iniciado em 2026-05-02. Esta base registra o contrato arquitetural antes
do primeiro codigo funcional.

## Principio central

O CLI nao captura cookies nem implementa login nao oficial. Ele usa os CLIs oficiais
como ponte de autenticacao e execucao:

- `codex` para OpenAI/Codex com conta ChatGPT ou API key.
- `claude` para Claude Code com conta Claude.ai, Console ou token OAuth suportado.
- `gemini` para Gemini CLI com Login with Google, API key ou Vertex.

## MVP 1.0

Fluxo alvo:

```bash
blueprint init
blueprint providers
blueprint auth doctor
blueprint plan
blueprint lint
```

Comandos ja implementados no scaffold atual:

- `blueprint providers --models`
- `blueprint profile init`
- `blueprint profile show`
- `blueprint profile validate`
- `blueprint registry export`
- `blueprint registry show`
- `blueprint registry validate`
- `blueprint auth doctor`
- `blueprint auth doctor --provider google --live`
- `blueprint doctor`
- `blueprint init`
- `blueprint plan`
- `blueprint lint`
- `blueprint revise`
- `blueprint export`
- `blueprint tui`

Saida alvo no projeto do usuario:

```text
.blueprint/
  profile.yaml
  blueprint.yaml
  architecture.md
  assumptions.md
  decisions.md
  risks.md
  dependencies_graph.json
  integration_guide.md
  tasks/
    001-example.md
```

Profile local para este ambiente, enquanto Claude estiver sem cota:

```bash
blueprint profile init --providers openai,google --planner-provider openai --force
blueprint profile validate
```

Se OpenAI/Codex tambem estiver sem cota, manter o mesmo pool e trocar somente o
planner para Gemini:

```bash
blueprint profile init --providers openai,google --planner-provider google --project-registry --force
blueprint profile validate
```

Registry customizavel por projeto:

```bash
blueprint registry export
blueprint registry validate
blueprint profile init --providers openai,google --planner-provider openai --project-registry --force
```

Planejamento MVP:

```bash
blueprint plan
blueprint plan --engine llm --fallback
blueprint lint
blueprint export
```

Para automacao ou testes, o mesmo comando aceita respostas em JSON:

```bash
blueprint plan --answers ./plan-answers.json --yes --force
blueprint plan --answers ./plan-answers.json --engine llm --fallback --yes --force
```

Revisao cirurgica MVP:

```bash
blueprint revise --change "Adicione teste de contrato na task 004"
blueprint revise --change "Adicione criterio de lint no acceptance_contract da task 004" --apply
blueprint revise --change "Faça task-004 depender também da task-002" --apply
blueprint revise --change "Mude o banco para MongoDB" --dry-run
blueprint revise --file ./change-request.txt --json
blueprint revise --change "Atualize integration_guide.md" --apply
```

Export transportavel dos handoffs:

```bash
blueprint export
blueprint export --out ./handoffs --force
blueprint export --include-revisions --json
```

Dashboard TUI:

```bash
blueprint tui
blueprint tui --view tasks
blueprint tui --view actions
blueprint tui --json
```

Na aba `actions`, a TUI executa `lint`, `export`, `auth doctor` e um fluxo
guiado de `revise`: digita a mudanca, revisa o dry-run e confirma antes de
aplicar. Cada acao executada pela TUI fica auditada em
`.blueprint/tui_sessions/*.json`.

## Leitura inicial

1. `AGENTS.md`
2. `docs/DESIGN_LOCK.md`
3. `docs/MVP_ROADMAP.md`
4. `docs/OPERATIONAL_SOURCES.md`
5. specs em `docs/SPECS/`
6. ADRs em `docs/ADR/`

Contrato do planner LLM: `docs/SPECS/planner_llm_contract.md`.

## Stack planejada

- TypeScript + Node 20+
- `commander` para comandos
- `ink` para TUI rica
- `@clack/prompts` para prompts simples
- `zod` para contratos e validacao de artefatos
- `execa` para chamar CLIs oficiais
- `fast-glob` + `ignore` para inventario de contexto
- `vitest` para testes

## Live provider checks

O `auth doctor` normal evita chamadas de modelo quando o provider expoe um status
local de auth. Para validar inferencia de verdade em qualquer provider suportado:

```bash
blueprint auth doctor --provider google --live
blueprint auth doctor --provider openai --live
blueprint auth doctor --provider anthropic --live
```

Essas verificacoes rodam em diretorio temporario vazio, com modos read-only/plan
quando o CLI oficial oferece essa opcao. Elas consomem uma chamada curta do
provider. No Gemini, o modo padrao continua `not_checked` porque o CLI local nao
expoe um comando de auth/status sem inferencia.
