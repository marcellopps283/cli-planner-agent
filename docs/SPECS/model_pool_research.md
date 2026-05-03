# Spec - Model Pool Research

Verificado em 2026-05-03. O registry bundled deve ser revisado com frequencia,
porque disponibilidade, nomes de modelos, precos e benchmarks mudam rapido.

## Conclusao operacional

O roteamento do planner deve escolher IDs exatos de modelos, nao providers. O
provider ainda define como autenticar e chamar o CLI oficial, mas o handoff deve
carregar `suggested_model` como `gpt-5.5`, `claude-opus-4-7` ou
`gemini-3.1-pro-preview`.

Pool inicial recomendado:

- OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`; `gpt-5.5-pro` fica no registry
  como restricted e so entra no pool quando o usuario selecionar explicitamente.
- Anthropic: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- Google: `gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`,
  `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`.

## Evidencias por provider

### OpenAI

Fontes oficiais:

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/guides/latest-model
- https://openai.com/index/introducing-gpt-5-5/
- https://developers.openai.com/api/docs/pricing

Sinais para o registry:

- `gpt-5.5` e o modelo recomendado pela documentacao de modelos para raciocinio
  complexo e coding.
- O model ID oficial e `gpt-5.5`, com janela de contexto de 1M tokens e max
  output de 128k tokens.
- Benchmarks publicados no lancamento: Terminal-Bench 2.0 82.7%, SWE-Bench Pro
  58.6%, GDPval 84.9%, OSWorld-Verified 78.7%, BrowseComp 84.4%.
- `gpt-5.4-mini` e `gpt-5.4-nano` existem como opcoes menores, mas o MVP usa
  `gpt-5.4-mini` para tarefas pequenas de coding/JSON por ser o menor modelo
  que a doc destaca para coding/subagents.

### Anthropic

Fontes oficiais:

- https://platform.claude.com/docs/en/about-claude/models/overview
- https://www.anthropic.com/news/claude-opus-4-7
- https://www.anthropic.com/claude/opus
- https://claude.com/pricing

Sinais para o registry:

- `claude-opus-4-7` e o ID oficial do Claude API e o modelo Opus mais novo
  geralmente disponivel, lancado em 2026-04-16.
- A propria Anthropic recomenda Opus 4.7 para tarefas mais complexas e agentic
  coding.
- Benchmarks/textos publicados no lancamento: CursorBench 70%, BigLaw Bench
  90.9% em high effort, +13% em benchmark interno de 93 tarefas de coding e
  98.5% em benchmark visual de computer use.
- `Claude Mythos Preview` nao entra no pool default: a doc oficial o descreve
  como preview separado, invitation-only e sem self-serve sign-up.

### Google

Fontes oficiais:

- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
- https://deepmind.google/models/model-cards/gemini-3-1-pro/
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/
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

## Regras de separacao no MVP

- `frontier`: planejamento mestre, arquitetura, coding complexo e review de alto
  risco.
- `balanced`: implementacao comum, refactor moderado e validacao.
- `utility`: transformacoes pequenas, JSON/YAML, classificacao, resumo e tarefas
  baratas de alto volume.
- `specialized`: variantes com um comportamento operacional especifico, como
  custom tools.

O LLM planner recebe `task_fit`, `routing_tags`, precos, contexto e benchmarks,
mas o CLI valida que `suggested_model` existe em `available_models`.
