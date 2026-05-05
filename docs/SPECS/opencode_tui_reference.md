# Spec - OpenCode-Inspired TUI Reference

Verificado em 2026-05-04.

Fontes:

- https://dev.opencode.ai/docs/
- https://dev.opencode.ai/docs/tui/
- https://dev.opencode.ai/docs/commands/
- https://opencode.ai/
- https://hotaisle.xyz/assets/blog/opencode-vllm-hotaisle/opencode-connected.png
- https://lliksgqqtckk4xdy.public.blob.vercel-storage.com/kanaries-docs/topics/ai-coding/opencode-how-to-use/oh-my-opencode-preview-gM8JM9P3TMJuY5lYAkolGPNOPo3bvj.jpg

## O que importa no OpenCode

OpenCode abre a TUI diretamente no diretorio atual, sem exigir uma camada de
dashboard antes da conversa. A acao principal e digitar uma mensagem. Comandos
locais entram pelo prefixo `/`, e o usuario usa comandos como `/help`,
`/models`, `/sessions`, `/init` e `/export` sem sair da conversa.

O layout que interessa para Blueprint e:

- entrada inicial centrada com logotipo, caixa de prompt, modo/modelo e dica;
- transicao para uma tela de trabalho apos a primeira mensagem;
- painel lateral persistente com contexto, providers, stack, todo e quota;
- comandos slash com autocomplete navegavel por setas;
- seletor de modelo de conversa invocado por `tab`;
- overlays para selecao, configuracao e confirmacao;
- feed principal com cards de tarefas/background, plano, progresso e input
  inferior.

## Decisoes para o Blueprint

- `blueprint` abre em `Plan / Actions`, nao no `Main Menu`.
- Em TTY real, a TUI usa alternate screen para ocupar a janela do terminal em
  vez de renderizar abaixo do prompt do shell.
- `Main Menu` e uma camada sob demanda via `/menu` ou `--view main`.
- Antes da primeira solicitacao, a tela mostra `blueprint`, `Ask anything...`,
  modo `Plan`, planner primario, dica e atalhos `tab`/`ctrl+p`.
- Depois da primeira mensagem, a tela vira workbench com feed principal, input
  inferior e sidebar de `Context`, `MCP`, `LSP` e `Todo`.
- `tab` abre os modelos disponiveis no provider/CLI conectado ao planner atual;
  `/model [id]` troca o modelo usado no chat.
- O feed usa cards textuais para intake, preview de tarefas e handoffs ja
  gerados.
- Quota real ainda e `n/a`, mas o slot da sidebar fica reservado.

## Proximas Fatias

1. Persistir historico de conversa real, nao apenas historico de acoes.
2. Adicionar `/sessions` para reabrir historicos.
3. Adicionar comandos customizaveis por projeto.
4. Evoluir o artefato para acompanhar progresso de workers na versao 2.0.
