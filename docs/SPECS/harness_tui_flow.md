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
5. Usuario escolhe o provider/modelo planner.
6. App cria ou atualiza `.blueprint/`, `profile.yaml` e `model_registry.yaml`.
7. App abre painel operacional com status, metricas, provider pool, model pool,
   registry, artefatos, tasks e acoes.
8. Ao iniciar uma tarefa, app muda para uma experiencia de chat.
9. Planner conversa com o usuario, entende a entrega e monta um plano.
10. Antes de escrever handoffs, app mostra task graph, modelo sugerido por task
    e pede confirmacao.
11. Apos confirmacao, app gera os arquivos e informa os paths criados.

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
- O setup interativo passa por providers, modelos por provider, planner e
  confirmacao antes de escrever arquivos.
- O onboarding mostra a deteccao local dos CLIs `codex`, `claude` e `gemini`,
  incluindo status de auth quando disponivel sem chamada de modelo.
- A TUI abre no `Main Menu`, que centraliza acesso a `Plan / Actions`,
  `Overview`, `Tasks`, `Dependency Graph` e `Providers / Models`.
- Telas operacionais nao fazem rotacao lateral entre si; `m` ou `Esc` retorna
  ao `Main Menu`, e a troca de contexto passa pelo menu principal.
- A referencia de evolucao visual/fluxo esta documentada em
  `docs/SPECS/hermes_tui_reference.md`: chat principal, status line, slash
  commands e overlays modais no estilo Hermes Agent.
- O overview fica atras do menu principal e inclui um painel `Operations` com
  status operacional, planner, providers, model pool, tasks, task models e
  sessoes.
- O backend de setup aceita selecao explicita de providers/modelos/planner para
  manter o fluxo testavel e auditavel.
- A tela `actions` tem `Start Planning Chat`, um fluxo guiado que coleta escopo
  dentro da TUI e chama o PlannerEngine LLM do profile sem exigir que o usuario
  saia para outro comando.
- O chat comeca por um brief livre e depois pede os campos estruturados minimos
  para manter o contrato de planejamento validavel.
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
