# ADR 003 - Manifests do projeto governam stack e dependencias

Data: 2026-05-09

## Status

Aceito

## Contexto

O harness roda no computador do usuario e detecta CLIs, arquivos e manifests.
Essa deteccao e util para autenticacao, validacao e inventario, mas cria um
risco: o planner pode sugerir frameworks ou bibliotecas porque algo esta
instalado globalmente na maquina, mesmo quando o projeto nao usa aquilo.

## Decisao

O planner deve tratar a stack como evidencia do repositorio, nao do ambiente
local. Frameworks, bibliotecas, bancos, build tools e test frameworks devem vir
de manifests/configs visiveis no projeto ou de pedido explicito do usuario.

Quando uma dependencia nova parecer necessaria, ela deve aparecer como decisao
pendente de confirmacao, nao como arquitetura ja escolhida.

## Consequencias

Beneficios:

- reduz sugestoes oportunistas baseadas no PC do usuario;
- mantem handoffs fieis ao projeto real;
- evita instalar dependencias sem consentimento.

Custos:

- o planner pode fazer mais perguntas antes de sugerir uma stack nova;
- o inventario precisa resumir dependencias declaradas nos manifests.

## Alternativas consideradas

- Permitir sugestoes livres do LLM: rejeitado por gerar planos desalinhados.
- Bloquear qualquer dependencia nova: rejeitado porque projetos novos podem
  precisar escolher stack com o usuario.
