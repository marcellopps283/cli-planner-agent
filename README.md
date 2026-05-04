# CLI Planner-Agent

> Nome provisorio. O produto final ainda precisa de naming antes de publicacao.

CLI para planejar projetos de software com modelos LLM ja autenticados pelo usuario.
O MVP e um planner puro: conversa com o usuario, entende o repo, quebra o escopo
em um grafo de tarefas e gera artefatos de handoff para execucao manual em agentes
como Codex, Claude Code e Gemini CLI.

## Status

MVP funcional, privado no GitHub e com CI ativo em `main`. O estado atual cobre
inicializacao, profiles com pool de modelos exatos, registry customizavel,
doctor, planner deterministico, planner LLM via CLI oficial, lint, revise,
export e TUI.

## Principio central

O CLI nao captura cookies nem implementa login nao oficial. Ele usa os CLIs oficiais
como ponte de autenticacao e execucao:

- `codex` para OpenAI/Codex com conta ChatGPT ou API key.
- `claude` para Claude Code com conta Claude.ai, Console ou token OAuth suportado.
- `gemini` para Gemini CLI com Login with Google, API key ou Vertex.

## MVP 1.0

Fluxo alvo:

```bash
blueprint
```

`blueprint` sem subcomando abre a TUI. Os subcomandos continuam disponiveis para
automacao e debugging.

## Instalacao local

Enquanto o pacote continuar privado, use o checkout local:

```bash
pnpm install
pnpm build
pnpm link --global
blueprint --help
```

Para validar o pacote sem publicar:

```bash
pnpm pack --pack-destination /tmp/blueprint-pack
npm install --global --prefix /tmp/blueprint-global /tmp/blueprint-pack/cli-planner-agent-0.0.0.tgz
/tmp/blueprint-global/bin/blueprint --help
```

Comandos ja implementados no scaffold atual:

- `blueprint`
- `blueprint providers --models`
- `blueprint profile init`
- `blueprint profile show`
- `blueprint profile validate`
- `blueprint registry export`
- `blueprint registry refresh`
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

Profile local para este ambiente, enquanto Claude estiver sem cota. O roteamento
usa model IDs exatos; se `--models` for omitido, o CLI inclui os modelos
self-serve conhecidos dos providers selecionados:

```bash
blueprint profile init --providers openai,google --planner-provider openai --planner-model gpt-5.5 --force
blueprint profile validate
```

Se OpenAI/Codex tambem estiver sem cota, manter o mesmo pool e trocar somente o
planner para Gemini:

```bash
blueprint profile init --providers openai,google --planner-provider google --project-registry --force
blueprint profile validate
```

Para restringir o pool a poucos modelos:

```bash
blueprint profile init \
  --providers openai,google \
  --models gpt-5.5,gemini-3.1-pro-preview,gemini-3.1-flash-lite-preview \
  --planner-provider openai \
  --planner-model gpt-5.5 \
  --force
```

Registry customizavel por projeto:

```bash
blueprint profile init --providers openai,google --planner-provider openai --project-registry --force
blueprint registry refresh
blueprint registry validate
```

Planejamento MVP:

```bash
blueprint plan
blueprint plan --engine llm --fallback
blueprint lint
blueprint export
```

No modo interativo, o planner monta um preview do grafo e mostra o modelo
sugerido por task antes de escrever os handoffs. Com `--answers` e `--yes`, o
fluxo continua proprio para automacao e testes.

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

O overview abre com um painel `Operations` para status operacional, planner,
provider pool, model pool, tasks, modelos usados e sessoes TUI recentes.

Se a TUI for aberta em um diretorio sem `.blueprint/`, ela entra em modo de
onboarding: mostra o diretorio atual, permite manter/trocar/criar pasta e depois
guia a selecao de providers, modelos por provider e modelo planner antes de criar
`.blueprint/`, `profile.yaml` e `model_registry.yaml`. Nessa tela inicial,
`Enter` mantem o diretorio atual e `c` permite escolher outro diretorio sem sair
do app.

Na aba `actions`, a TUI inicia um fluxo de planejamento em estilo chat, mostra o
preview `task -> modelo` antes de escrever handoffs, configura o model pool por
IDs exatos, executa `lint`, `export`, `auth doctor` e um fluxo guiado de
`revise`: digita a mudanca, revisa o dry-run e confirma antes de aplicar. Cada
acao executada pela TUI fica auditada em `.blueprint/tui_sessions/*.json`.
Quando o plano e gerado, o resultado destaca `.blueprint/`, `.blueprint/tasks`,
`dependencies_graph.json` e `integration_guide.md` antes da lista completa de
arquivos.

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
