# Spec - Harness TUI Flow

## Objetivo

Reposicionar o produto como um harness de agente de IA. O usuario deve abrir
`blueprint` e operar por uma unica frente, com subcomandos servindo apenas para
automacao, smoke e debugging.

## Experiencia principal

1. Usuario roda `blueprint`.
2. App mostra o diretorio atual e permite manter, trocar ou criar projeto.
3. App detecta CLIs oficiais instalados e pede quais providers o usuario possui.
4. Para cada provider selecionado, app mostra uma tela de modelos suportados,
   com acao de selecionar todos ou marcar manualmente.
5. Para cada modelo selecionado com suporte a reasoning, app pede o esforco de
   raciocinio daquele modelo em uma tela dedicada.
6. Usuario escolhe o provider/modelo planner entre o pool selecionado.
7. App cria ou atualiza `.blueprint/`, `profile.yaml` e `model_registry.yaml`.
8. App abre painel operacional com status, metricas, provider pool, model pool,
   registry, artefatos, tasks e acoes.
9. Ao iniciar uma tarefa, app muda para uma experiencia de chat.
10. A primeira mensagem aciona o modelo planner ativo, que devolve um estado de
    workflow agentico: entendimento do projeto, fase atual, checklist validada,
    perguntas e proxima acao.
11. O app renderiza esse estado como harness; o modelo controla status
    semantico de checkboxes/perguntas, nunca layout.
12. Antes de escrever handoffs, app mostra task graph, modelo sugerido por task
    e pede confirmacao.
13. Apos confirmacao, app gera os arquivos e informa os paths criados.

## Regras

- Configuracao acontece no inicio, nao por conveniencia depois.
- Providers sao fronteira de autenticacao; modelos sao unidade de roteamento.
- O banco comparativo de modelos e quase interno, mas IDs e selecao precisam ser
  visiveis durante onboarding.
- Handoffs devem ser completos o suficiente para outro agente executar sem
  depender da memoria da conversa.
- MVP 1.0 planeja e gera handoffs; nao executa workers.

## Status implementado

- `blueprint` sem subcomando abre a TUI.
- O setup interativo passa por providers, modelos por provider, reasoning
  effort por modelo, planner e confirmacao antes de escrever arquivos.
- O onboarding mostra a deteccao local dos CLIs `codex`, `claude` e `gemini`,
  incluindo status de auth quando disponivel sem chamada de modelo.
- A TUI abre direto no chat `Plan / Actions`; `Main Menu` e uma camada sob
  demanda via `/menu` ou `--view main`.
- O chat tem uma landing inicial centrada, com logo, prompt `Ask anything...`,
  planner/modelo ativo, dica e opcoes de configuracao por slash command antes
  da primeira mensagem.
- A referencia principal de evolucao visual/fluxo esta documentada em
  `docs/SPECS/opencode_tui_reference.md`: landing de chat, feed principal,
  sidebar contextual, slash commands, overlays e artefato de progresso no
  estilo OpenCode.
- O overview fica atras do menu principal e inclui um painel `Operations` com
  status operacional, planner, providers, model pool, tasks, task models e
  sessoes.
- O backend de setup aceita selecao explicita de providers, modelos, reasoning
  efforts e planner para manter o fluxo testavel e auditavel.
- A tela `actions` agora e um workbench de chat: tem feed principal, input
  permanente, sidebar contextual e slash commands para acoes locais.
- Depois da primeira mensagem, a tela vira workbench e executa
  `agent-workflow`: o texto vai para o planner LLM ativo e a TUI renderiza o
  estado JSON devolvido pelo modelo.
- O estado agentico inclui `project_state`, mensagens do planner, checklist com
  status `done/in_progress/pending/blocked`, perguntas e `next_action`.
- O modelo decide o estado semantico dos itens interativos que ele valida; a TUI
  continua dona do layout, controles e renderizacao.
- Texto livre ou `/plan [brief]` inicia o planejamento; `/providers`,
  `/model`, `/models`, `/registry`, `/lint`, `/export`, `/revise`, `/auth`,
  `/auth-live`, `/help` e `/menu` mantem o usuario em uma unica frente
  operacional.
- O autocomplete visual filtra comandos enquanto o input comeca com `/`; `↑↓`
  navega pelas sugestoes e `Tab` completa a opcao selecionada.
- `Tab` sem slash abre o seletor do modelo de conversa; ao escolher um modelo
  com reasoning configuravel, a proxima tela escolhe o esforco e persiste ambos
  em `profile.yaml`.
- Perguntas, confirmacoes e edicoes guiadas aparecem em overlays de foco em vez
  de competirem com o painel principal do chat.
- O chat comeca por texto livre. Campos estruturados viram schema interno do
  workflow agentico; o planner deve inferir lacunas de forma conservadora e so
  perguntar ao usuario quando estiver realmente bloqueado.
- `blueprint plan` monta preview de task graph/modelo por task e pede
  confirmacao antes de persistir handoffs no modo interativo.
- O PlannerEngine passa o model ID exato ao CLI oficial e tenta reparar uma
  resposta JSON invalida antes de acionar fallback.
- O preview de planejamento inclui justificativa de modelo e alternativas
  aceitaveis por task.
- Falhas do planner na TUI viram um proximo passo confirmavel: outro modelo do
  pool ativo ou preview deterministico.
- Depois da geracao, a TUI destaca artifact root, tasks dir, graph e integration
  guide antes de listar os arquivos completos.
