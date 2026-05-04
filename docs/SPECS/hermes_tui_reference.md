# Spec - Hermes-Inspired TUI Reference

Verificado em 2026-05-04.

Fontes:

- https://hermes-agent.nousresearch.com/docs/user-guide/cli
- https://hermes-agent.nousresearch.com/docs/user-guide/tui
- https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/

## O que importa no Hermes

Hermes trata a experiencia principal como um chat de agente no terminal, nao
como um dashboard de abas. A TUI moderna usa a mesma runtime e sessoes do CLI
classico, mas adiciona uma superficie mais responsiva com overlays modais,
selecao por mouse, entrada nao bloqueante, historico de conversa, comandos slash,
autocomplete, input multiline, status line em tempo real e streaming de tool
output.

O usuario entra direto em uma conversa. Paineis, configuracoes, sessoes e
metricas aparecem como comandos ou overlays, sem competir com o prompt principal.

## Decisoes para o Blueprint

- O comando unico continua sendo `blueprint`.
- `Plan / Actions` e a primeira superficie, seguindo o fluxo do OpenCode:
  abrir no chat, digitar uma mensagem e entao entrar em uma tela de trabalho.
- `Main Menu` fica sob demanda, invocado por `/menu` ou `--view main`.
- A fase de planejamento deve evoluir de wizard pergunta-a-pergunta para input
  livre com comandos slash.
- Configuracoes e metricas devem abrir como overlays ou telas temporarias:
  `/providers`, `/models`, `/usage`, `/sessions`, `/export`, `/lint`.
- A sidebar/status area deve mostrar `ready`, `planning`, `running`,
  `needs-confirmation` ou `blocked`, junto de planner/modelo atual.
- Output de acoes deve streamar dentro do painel de conversa, preservando
  historico e o caminho dos artefatos gerados.
- O workbench deve manter um artefato visivel para a IA: checklist de
  requisitos, preview de tarefas e handoffs gerados.
- Interrupcao deve ser natural: `Esc` volta ao menu/overlay anterior; `Ctrl+C`
  cancela a acao atual antes de sair do app.

## Ordem sugerida

1. Consolidar `Plan / Actions` como chat principal. Feito no MVP atual.
2. Adicionar sidebar/status area com planner/modelo/estado. Feito no MVP atual.
3. Adicionar comandos slash locais com autocomplete textual simples. Feito no
   MVP atual.
4. Trocar formularios longos por overlays modais. Base feita no MVP atual para
   planejamento, confirmacao, model pool e revise.
5. Persistir sessoes TUI como historico reabrivel, usando os registros atuais em
   `.blueprint/tui_sessions/` como ponto de partida.
