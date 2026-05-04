# MVP Roadmap

## Week 0 - Contrato e POCs

- [x] Design lock inicial.
- [x] ADR de auth via CLIs oficiais.
- [x] Specs iniciais de artefato, contexto e roteamento.
- [ ] Escolher nome final do produto.
- [x] POC: detectar `codex`, `claude`, `gemini` e auth/status. Smoke local em 2026-05-02: os tres CLIs foram encontrados; `codex login status` e `claude auth status` reportaram auth sem expor identificadores de conta; Gemini CLI fica como `not_checked` no modo padrao porque o help local nao expos comando de auth status sem chamada de modelo. A checagem real do Gemini usa `auth doctor --provider google --live`.
- [x] POC: chamar cada CLI em modo nao interativo com prompt simples. Smoke local em 2026-05-02: `codex exec` respondeu OK; `gemini -p` respondeu OK; `claude -p` executou o modo headless, mas a conta atual retornou API 403 apesar de `claude auth status` indicar login.
- [x] POC: gerar `.blueprint/` fixture validado por schema.

Gate:

- Se qualquer provider nao tiver modo nao interativo estavel, marcar como
  `interactive_only` no registry e nao usar para automacao.

## Week 1 - CLI base

- [x] `blueprint init`
- [x] `blueprint providers`
- [x] `blueprint auth doctor`
- [x] `blueprint auth doctor --provider google --live`
- [x] `blueprint auth doctor --provider <id> --live`
- [x] Config local de profiles.
- [x] Provider registry atualizavel.
- [x] Validacao com Zod.

Checkpoint:

- Usuario seleciona providers e o CLI mostra quais estao prontos. Profile local
  atual deste ambiente deve usar OpenAI + Google e excluir Anthropic enquanto a
  cota Claude estiver indisponivel.

## Week 2 - Context inventory

- [x] Inventario respeitando `.gitignore`.
- [x] Deteccao de docs canonicos.
- [x] Bloqueio de secrets.
- [x] Resumo de arvore e manifests.
- [ ] Prompt de pedido de acesso a arquivos sensiveis.

Checkpoint:

- `blueprint doctor` explica o que o planner pode ler e o que esta bloqueado.

## Week 3 - Planner TUI

- [x] Fluxo investigativo MVP com `@clack/prompts`.
- [x] Sessao de requisitos.
- [x] Resumo executivo antes de gerar arquivos.
- [x] Geracao de `.blueprint/`.
- [x] Modo planner LLM via CLI oficial com fallback deterministico.
- [x] Fixtures golden para contrato do planner LLM.
- [x] TUI rica com Ink: dashboard inicial `blueprint tui`.
- [ ] Evoluir prompt do planner LLM com exemplos por tipo de projeto.

Smoke local em 2026-05-02: OpenAI/Codex retornou limite de uso no modo planner
LLM e o fallback deterministico funcionou. O profile foi alternado para Gemini
como planner, `plan --engine llm` gerou 4 tasks e `blueprint lint` passou.

Smoke empacotado em 2026-05-03: `pnpm pack` + instalacao em prefixo temporario
validaram o bin `blueprint` fora do checkout. O smoke externo tambem confirmou
que `profile init --project-registry` precisa criar o registry local junto com
o profile para deixar `profile validate` verde logo depois.

Checkpoint:

- Um repo real gera plano com arquitetura, grafo e tasks.

## Week 4 - Lint e revisao

- [x] `blueprint lint`
- [x] Deteccao de conflitos de paths.
- [x] Validacao de dependencias.
- [x] `blueprint revise` v1 com classificacao local/global.
- [x] `blueprint revise --apply` para `local_doc`, `task_local` e dependencia
  explicita `graph_local` com rollback por lint.
- [x] `blueprint export` para pasta transportavel de handoffs com manifesto.
- [x] Golden fixtures iniciais via testes de blueprint.

Checkpoint:

- Mudanca pequena atualiza task correta; mudanca estrutural pede replanejamento.

## Week 5 - Produto e robustez pre-1.0

- [x] Configurar `available_models` dentro da TUI, sem exigir edicao manual de
  YAML.
- [ ] Definir politica ou comando de atualizacao do model registry, ja que
  disponibilidade, precos e benchmarks mudam rapido.
- [ ] Smoke final de uso real: `blueprint tui` -> setup -> profile/model pool ->
  `plan --engine llm --fallback` -> `lint` -> `export`.

Checkpoint:

- Usuario consegue configurar providers e modelos, gerar handoffs e exportar o
  pacote inteiro sem sair do app.

## 2.0 - Supervisor

- [ ] Runner de workers.
- [ ] Retorno normalizado de execucao.
- [ ] Status por task.
- [ ] Integracao de diffs.
- [ ] Confirmacao humana antes de fallback ou gasto relevante.
