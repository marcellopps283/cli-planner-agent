# Spec - Agent Harness Research

Verificado em 2026-05-09. Esta nota registra ideias aplicaveis ao Blueprint a
partir de leitura de docs e codigo publico de ferramentas agenticas.

## Fontes lidas

- OpenAI Codex docs: https://developers.openai.com/codex/cli
- OpenAI Codex non-interactive docs: https://www.mintlify.com/openai/codex/concepts/non-interactive-mode
- OpenAI Codex repo: https://github.com/openai/codex
- Claude Code docs: https://code.claude.com/docs/en/sessions
- Claude Code headless docs: https://code.claude.com/docs/en/headless
- Gemini CLI headless docs: https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- MCO multi-CLI orchestrator: https://github.com/mco-org/mco
- OpenCode repo: https://github.com/opencode-ai/opencode
- Claw Orchestrator repo: https://github.com/Enderfga/claw-orchestrator
- Claw Code overview: https://claw-code.codes/

## Padroes relevantes

- Claude Code recomenda separar exploracao, planejamento e implementacao; plan
  mode faz sentido quando ha incerteza, varios arquivos ou codigo desconhecido.
  O Blueprint deve manter essa separacao e transformar o preview aprovado em
  contrato, nao em uma sugestao que pode mudar no apply.
- Docs de Claude tambem enfatizam prompts com contexto especifico: arquivos,
  restricoes e padroes existentes. O workflow agentico deve alimentar o planner
  com inventario real de arquivos e preferir paths concretos nos handoffs.
- O inventario real e o repo, nao a maquina do usuario. CLIs, frameworks ou
  libs instalados globalmente nao devem virar recomendacao automatica de stack;
  dependencia nova precisa ser confirmada pelo usuario.
- Codex exec e Gemini headless sao pensados para automacao e saidas
  estruturadas. O Blueprint deve tratar JSON/schema, ultima mensagem, retries e
  exit codes como parte do adapter, e nao como detalhe de UI.
- OpenCode modela ferramentas e subagentes com permissoes explicitas e usa
  todo lists para tarefas complexas. Para o Blueprint 1.0, isso vira metadata:
  allowed_paths, forbidden_paths, task graph, fallback com confirmacao e
  checkboxes semanticas do planner.
- Sessao e thread sao contratos de primeira classe. Codex propaga `thread_id`
  em eventos, respostas e erros para permitir retomada, migracao e tooling
  externo. Blueprint deve preservar `session_id`, `updated_at`, mensagens e
  `agent_state` em `SESSION.json`.
- Plan mode deve ser engine-neutral. Claw Orchestrator evita depender de slash
  commands interativos e injeta instrucao de planejamento quando precisa
  funcionar em Claude, Codex, Gemini e engines customizadas. Blueprint segue
  esse padrao: o planner pode declarar `preview_plan`, mas escrita depende da
  confirmacao da TUI.
- Permissoes e fallback sao UX, nao detalhe interno. Codex/Claude expõem modos
  de permissao e overlays de aprovacao; Claw modela `permissionMode`,
  `fallbackModel`, `maxBudgetUsd` e `effort` no contrato de sessao. Blueprint
  deve confirmar fallback, live auth, registry refresh, preview e escrita.
- O roteamento moderno e por modelo, nao por provider. Claw centraliza
  registry/model aliases/context/pricing; Blueprint usa `available_models` e
  `routing_scorecards` para manter a escolha fina e auditavel.
- Planejamento longo deve ser tratavel como tarefa de fundo no futuro. Claw
  expoe `ultraplan_start/status`; Codex tem `/goal` persistente. No Blueprint
  1.0 isso vira apenas estado visual e arquivos; no 2.0 pode virar supervisor
  com workers reais.
- CLIs headless precisam de adapters especificos, nao um wrapper generico.
  Codex recomenda JSONL para automacao e captura da ultima mensagem; Claude
  expoe `-p --output-format json` e `--resume`; Gemini documenta `-p`,
  `--output-format json` e `--approval-mode`, mas tem historico de fragilidade
  no modo JSON. Blueprint deve tratar cada provider como runtime proprio.

## Aplicacoes no Blueprint

- Manter uma sessao unica por projeto no MVP, com `/resume`, `/sessions` e
  `/clear`.
- Exibir landing em toda abertura e deixar o usuario retomar por comando.
- Entrar no workbench apos a primeira mensagem com estado de thinking visivel.
- Tratar checkboxes como estado semantico do planner, nao como layout editavel.
- Gerar handoffs completos com modelo exato, alternativas, allowed paths,
  acceptance contract e comandos de validacao.
- Cachear o draft aprovado no preview e usar esse mesmo draft no apply. O
  usuario deve aprovar exatamente o plano que sera escrito.
- Normalizar comandos comuns de validacao para execucao reprodutivel, por
  exemplo `pnpm test run tests/foo.test.ts` deve virar
  `corepack pnpm test tests/foo.test.ts`.
- Aplicar piso de risco quando a task tocar `src/tui.ts`, `src/cli.ts`,
  providers, planner engine, fallback, auth, chat unificado ou estado global.
  O modelo ainda escolhe o plano, mas o harness corrige subestimativas obvias
  quando o `suggested_model` fica abaixo do score minimo para o fit/risco.
- Filtrar alternativas por fit/risco. Fallback de modelo deve continuar
  confirmavel pelo usuario, mas o handoff nao deve listar modelo fraco como
  alternativa aceitavel para tarefa complicada.
- `blueprint lint` deve alertar quando allowed paths nao existem ou quando
  comandos de teste nao sao reprodutiveis, sem bloquear novos arquivos
  intencionais que estejam declarados nas regras de contexto.
- Evoluir depois para `planner task background` e supervisor 2.0, inspirado em
  `/goal` e `ultraplan`, sem executar workers no MVP.
- Manter contrato de execucao em `provider_headless_execution.md`, incluindo
  pseudo-modelos de CLI, retries de Gemini e diagnosticos de fallback.
