# Spec - Provider Headless Execution

Verificado em 2026-05-09.

## Objetivo

Executar planners por CLIs oficiais, usando assinaturas consumer ou contas ja
autenticadas localmente, sem reimplementar login nem depender de scraping de
browser. O Blueprint deve atuar como harness: prepara contexto, chama o CLI
headless, valida o contrato JSON, registra diagnostico e so entao oferece
fallback confirmado.

## Fontes

- Gemini CLI Headless Mode: https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- Claude Code headless / Agent SDK CLI: https://code.claude.com/docs/en/headless
- Codex non-interactive mode: https://www.mintlify.com/openai/codex/concepts/non-interactive-mode
- MCO multi-CLI orchestrator: https://github.com/mco-org/mco
- OpenCode provider/model configuration: https://github.com/opencode-ai/opencode
- Gemini CLI JSON issue: https://github.com/google-gemini/gemini-cli/issues/9281
- OpenClaw Gemini headless note: https://www.reddit.com/r/openclaw/comments/1sy7rcc/

## Contrato de Execucao

- `codex exec`: usar `--json` para eventos de automacao, `-o` para capturar a
  ultima mensagem, sandbox read-only e `--ephemeral` no planner MVP.
- `claude -p`: usar `--output-format json`, `--permission-mode plan` e ler
  `result`. Quando disponivel, `--json-schema` pode substituir parte da
  validacao por prompt.
- `gemini -p`: usar `--output-format json` e `--approval-mode plan` primeiro.
  Se o processo falhar sem resposta ou o JSON for fragil, tentar
  `--approval-mode auto_edit` e, por fim, saida texto. Essa ordem segue a
  pratica headless documentada e evita que glitches de JSON mode bloqueiem o
  produto.

## Pseudo-modelos de CLI

Perfis antigos podem conter IDs como `openai-codex-default`,
`gemini-cli-default` e `claude-code-default`. Esses IDs significam "usar o
modelo default do CLI autenticado", portanto nao devem ser enviados como
`-m/--model`. Modelos reais, como `gpt-5.5` ou `gemini-3.1-pro-preview`,
continuam sendo passados explicitamente.

## UX de Falha

Falhas de provider nao sao final de fluxo. O TUI deve mostrar:

- provider/model que falhou;
- tentativa headless que falhou, quando houver;
- fallback disponivel e comando de confirmacao;
- quando nao houver fallback, proximo passo concreto: trocar modelo, rodar
  `blueprint auth doctor --live`, ou ajustar o profile.

## Evolucao

O MVP continua planner-only. Para 2.0, seguir o padrao dos orquestradores
modernos: multiplas sessoes isoladas, registro de runtime por provider,
workers em paralelo e resultados estruturados para merge/review.
