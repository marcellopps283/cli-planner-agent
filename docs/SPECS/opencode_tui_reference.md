# Spec - OpenCode-Inspired TUI Reference

Verificado em 2026-05-04.

Fontes:

- https://dev.opencode.ai/docs/
- https://dev.opencode.ai/docs/tui/
- https://dev.opencode.ai/docs/commands/
- https://opencode.ai/

## O que importa no OpenCode

OpenCode abre a TUI diretamente no diretorio atual, sem exigir uma camada de
dashboard antes da conversa. A acao principal e digitar uma mensagem. Comandos
locais entram pelo prefixo `/`, e o usuario usa comandos como `/help`,
`/models`, `/sessions`, `/init` e `/export` sem sair da conversa.

O layout que interessa para Blueprint e:

- entrada inicial centrada em uma pergunta ampla;
- transicao para uma tela de trabalho apos a primeira mensagem;
- status line sempre visivel com modo, modelo e informacoes operacionais;
- comandos slash com autocomplete;
- overlays para selecao, configuracao e confirmacao;
- artefato persistente na tela de trabalho para mostrar plano, progresso e
  proximas acoes.

## Decisoes para o Blueprint

- `blueprint` abre em `Plan / Actions`, nao no `Main Menu`.
- `Main Menu` e uma camada sob demanda via `/menu` ou `--view main`.
- Antes da primeira solicitacao, o chat mostra "What are we planning today?" e
  atalhos de configuracao por slash command.
- Depois da primeira mensagem, a tela vira workbench com `Planning Chat`,
  status line e `Blueprint Artifact`.
- O artefato usa checkboxes textuais para requisitos coletados, preview de
  tarefas e handoffs ja gerados.
- Quota real ainda e `n/a`, mas o slot de status line fica reservado.

## Proximas Fatias

1. Persistir historico de conversa real, nao apenas historico de acoes.
2. Adicionar `/sessions` para reabrir historicos.
3. Adicionar comandos customizaveis por projeto.
4. Evoluir o artefato para acompanhar progresso de workers na versao 2.0.
