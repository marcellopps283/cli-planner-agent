# ADR 003 - Stack nasce da conversa e do repositorio

Data: 2026-05-10

## Status

Aceito

## Contexto

O harness roda no computador do usuario e detecta CLIs, arquivos, manifests e
dependencias declaradas. Essa deteccao e util para autenticacao, validacao e
inventario, mas cria dois riscos opostos:

- o planner pode sugerir frameworks ou bibliotecas porque algo esta instalado
  globalmente na maquina;
- o planner pode endurecer demais o repo atual e limitar o brainstorming do
  usuario, mesmo quando o trabalho pede redesign, greenfield ou troca de stack.

## Decisao

O planner deve tratar a stack do repo como baseline, nao como trava. Durante o
brainstorming, ele pode propor frameworks, bibliotecas, bancos, build tools e
test frameworks novos, desde que apresente opcoes, tradeoffs e perguntas de
decisao.

Ferramentas instaladas globalmente ou disponiveis no PC nunca sao justificativa
implicita para escolher stack. Antes de gerar handoffs, qualquer dependencia ou
framework novo precisa estar confirmado pelo usuario ou continuar registrado
como decisao pendente, nao como instrucao de implementacao.

## Consequencias

Beneficios:

- reduz sugestoes oportunistas baseadas no PC do usuario;
- mantem handoffs fieis ao projeto real;
- evita instalar dependencias sem consentimento;
- preserva o papel do planner como parceiro de brainstorming.

Custos:

- o planner pode fazer mais perguntas antes de cristalizar uma stack nova;
- o inventario precisa resumir dependencias declaradas nos manifests.

## Alternativas consideradas

- Permitir sugestoes livres e ja transformar em handoff: rejeitado por gerar
  planos desalinhados.
- Bloquear qualquer dependencia nova: rejeitado porque projetos novos podem
  precisar escolher stack com o usuario.
