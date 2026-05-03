# ADR 001 - Usar CLIs oficiais como ponte de autenticacao

Data: 2026-05-02

## Status

Aceito

## Contexto

O produto quer permitir que usuarios aproveitem assinaturas consumer ou dev-tool
ja existentes em OpenAI, Anthropic e Google. A ideia inicial considerava capturar
tokens/cookies via browser/localhost intercept. Isso reduziria friccao, mas cria
risco alto de quebra, manutencao e conflito com termos de uso.

OpenAI Codex, Claude Code e Gemini CLI ja oferecem login oficial via conta do
usuario e modos de uso em terminal. Logo, o caminho mais robusto e integrar com
esses CLIs em vez de reimplementar auth.

## Decisao

O MVP usa `codex`, `claude` e `gemini` como bridges oficiais.

O CLI Planner-Agent:

- detecta se o CLI esta instalado;
- verifica status de autenticacao quando o provider expuser comando para isso;
- chama modo nao interativo quando suportado;
- nunca captura cookie de browser;
- nunca armazena token de provider que pertence a outro CLI.

## Consequencias

Beneficios:

- Menor risco juridico e operacional.
- Menor superficie de seguranca.
- Compatibilidade melhor com mudancas dos provedores.
- Produto mais publicavel.

Custos:

- Usuario precisa instalar/autenticar CLIs oficiais.
- Alguns providers podem ter modos nao interativos diferentes.
- O nosso app depende de estabilidade externa dos CLIs.

## Alternativas consideradas

- Capturar cookies/tokens web diretamente: rejeitado para MVP por fragilidade.
- API keys tradicionais: suportavel depois, mas nao e o foco consumer-first.
- SDKs diretos de cada provedor: util no futuro, mas nao resolve subscriptions
  consumer sem contrato especifico.

