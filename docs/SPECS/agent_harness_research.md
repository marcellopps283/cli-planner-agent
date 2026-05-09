# Spec - Agent Harness Research

Verificado em 2026-05-09. Esta nota registra ideias aplicaveis ao Blueprint a
partir de leitura de docs e codigo publico de ferramentas agenticas.

## Fontes lidas

- OpenAI Codex docs: https://developers.openai.com/codex/cli
- OpenAI Codex repo: https://github.com/openai/codex
- Claude Code docs: https://code.claude.com/docs/en/sessions
- Claw Orchestrator repo: https://github.com/Enderfga/claw-orchestrator
- Claw Code overview: https://claw-code.codes/

## Padroes relevantes

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

## Aplicacoes no Blueprint

- Manter uma sessao unica por projeto no MVP, com `/resume`, `/sessions` e
  `/clear`.
- Exibir landing em toda abertura e deixar o usuario retomar por comando.
- Entrar no workbench apos a primeira mensagem com estado de thinking visivel.
- Tratar checkboxes como estado semantico do planner, nao como layout editavel.
- Gerar handoffs completos com modelo exato, alternativas, allowed paths,
  acceptance contract e comandos de validacao.
- Evoluir depois para `planner task background` e supervisor 2.0, inspirado em
  `/goal` e `ultraplan`, sem executar workers no MVP.
