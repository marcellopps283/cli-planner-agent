# Spec - Model Pool Research

Verificado em 2026-05-09. O registry bundled deve ser revisado com frequencia,
porque disponibilidade, nomes de modelos, precos e benchmarks mudam rapido.

Politica MVP: o registry bundled guarda `metadata.bundled_revision` e
`metadata.research_verified_at`. Projetos que exportam um registry local devem
rodar `blueprint registry refresh` para sincronizar modelos bundled atualizados
sem perder modelos customizados do usuario.

## Conclusao operacional

O roteamento do planner deve escolher IDs exatos de modelos, nao providers. O
provider ainda define como autenticar e chamar o CLI oficial, mas o handoff deve
carregar `suggested_model` como `gpt-5.5`, `claude-opus-4-7` ou
`gemini-3.1-pro-preview`.

Pool inicial recomendado:

- OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano` e
  `gpt-5.3-codex`. `gpt-5.5-pro` e `gpt-5.4-pro` ficam no registry como
  restricted e so entram no pool quando o usuario selecionar explicitamente.
- Anthropic: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- Google: `gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`,
  `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`,
  `gemini-2.5-pro`, `gemini-2.5-flash` e `gemini-2.5-flash-lite`.

## Evidencias por provider

### OpenAI

Fontes oficiais:

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/models/gpt-5.4
- https://developers.openai.com/api/docs/models/gpt-5.4-mini
- https://developers.openai.com/api/docs/models/gpt-5.4-nano
- https://developers.openai.com/api/docs/models/gpt-5.3-codex
- https://developers.openai.com/api/docs/guides/latest-model
- https://openai.com/index/introducing-gpt-5-5/
- https://developers.openai.com/api/docs/pricing

Sinais para o registry:

- `gpt-5.5` e o modelo recomendado pela documentacao de modelos para raciocinio
  complexo e coding.
- O model ID oficial e `gpt-5.5`, com janela de contexto de 1,050,000 tokens e max
  output de 128k tokens.
- Benchmarks publicados no lancamento: Terminal-Bench 2.0 82.7%, SWE-Bench Pro
  58.6%, GDPval 84.9%, OSWorld-Verified 78.7%, BrowseComp 84.4%.
- Esforco OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` e `gpt-5.4-nano`
  aceitam `none`, `low`, `medium`, `high`, `xhigh`; modelos Pro usam
  `medium`, `high`, `xhigh`.
- `gpt-5.4-mini` e o utilitario de coding/subagents. `gpt-5.4-nano` entra para
  classificacao, extracao e micro-edicoes de custo minimo. `gpt-5.3-codex`
  entra como modelo especializado para agentic coding no Codex CLI.

### Anthropic

Fontes oficiais:

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://docs.anthropic.com/en/docs/claude-code/model-config
- https://www.anthropic.com/news/claude-opus-4-7
- https://www.anthropic.com/claude/opus
- https://www.anthropic.com/claude/sonnet
- https://www.anthropic.com/news/claude-haiku-4-5
- https://claude.com/pricing

Sinais para o registry:

- `claude-opus-4-7` e o ID oficial do Claude API e o modelo Opus mais novo
  geralmente disponivel, lancado em 2026-04-16.
- A propria Anthropic recomenda Opus 4.7 para tarefas mais complexas e agentic
  coding.
- Benchmarks/textos publicados no lancamento: CursorBench 70%, BigLaw Bench
  90.9% em high effort, +13% em benchmark interno de 93 tarefas de coding e
  98.5% em benchmark visual de computer use.
- Claude Code aceita aliases (`opus`, `sonnet`, `haiku`, `opusplan`) e nomes
  completos. O registry usa nomes exatos (`claude-opus-4-7`,
  `claude-sonnet-4-6`, `claude-haiku-4-5`) para evitar ambiguidade.
- Esforco Claude Code: a CLI local expõe `--effort low|medium|high|xhigh|max`.
  O default operacional do registry e `high` para Opus, `medium` para Sonnet e
  `low` para Haiku.

### Google

Fontes oficiais:

- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-preview
- https://deepmind.google/models/model-cards/gemini-3-1-pro/
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/
- https://ai.google.dev/gemini-api/docs/thinking
- https://ai.google.dev/gemini-api/docs/pricing

Sinais para o registry:

- `gemini-3.1-pro-preview` e o model code oficial e substitui o Gemini 3 Pro
  Preview, que a documentacao informa como deprecated/shutdown em 2026-03-09.
- O modelo tem 1,048,576 tokens de input e 65,536 tokens de output.
- Benchmarks do model card: SWE-Bench Verified 80.6%, SWE-Bench Pro 54.2%,
  LiveCodeBench Pro 2887 Elo, ARC-AGI-2 77.1%, BrowseComp 85.9%.
- `gemini-3.1-pro-preview-customtools` deve ser tratado como variante
  especializada para workers com bash/custom tools.
- `gemini-3.1-flash-lite-preview` e o utilitario barato para alto volume,
  com preco oficial de $0.25 input / $1.50 output por 1M tokens no tier paid
  standard.
- Google lista `gemini-2.5-pro`, `gemini-2.5-flash` e
  `gemini-2.5-flash-lite` como modelos atuais nao-deprecated; eles entram como
  fallback estavel quando o usuario quer evitar previews.
- Esforco Gemini: modelos Gemini 3 Pro aceitam `thinkingLevel low|high`;
  Gemini 3 Flash/Flash-Lite aceitam `minimal|low|medium|high`; Gemini 2.5 usa
  `thinkingBudget` em vez de `thinkingLevel`.

## Regras de separacao no MVP

- `frontier`: planejamento mestre, arquitetura, coding complexo e review de alto
  risco.
- `balanced`: implementacao comum, refactor moderado e validacao.
- `utility`: transformacoes pequenas, JSON/YAML, classificacao, resumo e tarefas
  baratas de alto volume.
- `specialized`: variantes com um comportamento operacional especifico, como
  custom tools.

O LLM planner recebe `task_fit`, `routing_tags`, precos, contexto, benchmarks e
`routing_scorecards` por risco. O CLI valida que `suggested_model` existe em
`available_models`.

## Pesquisa adicional de workflow agentico - 2026-05-09

Fontes oficiais consultadas:

- https://developers.openai.com/codex/cli
- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/learn/best-practices
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/interactive-mode
- https://code.claude.com/docs/en/permission-modes

Aplicacoes no Blueprint:

- sessoes devem ser salvas localmente e retomadas por comando explicito;
- plan mode/read-only deve existir como contrato de seguranca antes de escrita;
- comandos locais precisam morar no chat, nao em telas separadas obrigatorias;
- fallback de modelo e qualquer acao sensivel devem passar por confirmacao;
- subagentes/workers ficam para a versao 2.0, mas a versao 1.0 ja deve gerar
  handoffs com contratos de escopo, paths e validacao.
