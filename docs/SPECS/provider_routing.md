# Spec - Provider Routing

## Objetivo

Permitir que o planner mestre recomende o melhor worker para cada tarefa usando
apenas os modelos exatos selecionados pelo usuario. Providers continuam sendo a
fronteira de autenticacao/CLI, mas a unidade de roteamento e o model ID.

## MVP

Decisao por LLM com banco atualizavel de modelos.

Entradas:

- lista de providers disponiveis para auth;
- lista de modelos exatos no pool ativo;
- benchmarks e criterios de separacao do registry;
- tipo da task;
- complexidade;
- risco;
- contexto necessario;
- privacidade;
- quota/custo conhecidos.

O pool ativo vem de `.blueprint/profile.yaml`. Providers sem cota, ausentes ou
desmarcados pelo usuario ficam no registry, mas nao entram em `available_providers`.
Modelos fora de `available_models` nao podem ser escolhidos pelo roteador para
novas tasks. Profiles antigos sem `available_models` usam todos os modelos dos
providers disponiveis como fallback de compatibilidade.

Saida:

- `suggested_model`
- justificativa curta
- alternativas aceitaveis
- motivo para nao usar modelos excluidos

## Registry

Arquivo global ou por projeto:

```yaml
models:
  - id: claude-opus-4-7
    provider: anthropic
    access_mode: claude_code
    status: stable
    tier: frontier
    release_date: 2026-04-16
    task_fit:
      planning: 0.98
      coding_heavy: 0.95
      review: 0.9
    context_window: 1000000
    input_price_usd_per_mtok: 5
    output_price_usd_per_mtok: 25
    reasoning_efforts:
      - low
      - medium
      - high
      - xhigh
      - max
    default_reasoning_effort: high
    routing_tags:
      - planner_master
      - agentic_coding
    benchmark_scores:
      - name: CursorBench
        score: 70%
        source: Anthropic Opus 4.7 launch
    strengths:
      - long horizon planning
      - difficult coding
      - instruction following
    weaknesses:
      - quota pressure
    latency_class: medium
    cost_class: subscription
    privacy_notes: user subscription through official CLI
    recommended_uses:
      - architecture planning
      - complex implementation tasks
    avoid_for:
      - tiny formatting tasks
```

## Dimensoes sugeridas

- fit por tipo de trabalho;
- tier/status do modelo;
- benchmarks relevantes;
- complexidade;
- contexto;
- velocidade;
- esforco de raciocinio suportado;
- quota;
- custo;
- privacidade;
- estabilidade do provider;
- formato de saida;
- suporte multimodal;
- tolerancia a erro.

## Futuro hibrido

Adicionar score deterministico antes do LLM:

```text
score = fit*0.45 + reliability*0.20 + context*0.15 + speed*0.10 + cost*0.05 + privacy*0.05
```

No MVP nao persistimos scorecard real. Isso fica para uma versao posterior.

O registry bundled pode ser exportado para `.blueprint/model_registry.yaml` com
`blueprint registry export`. O usuario pode editar esse arquivo para ajustar
tiers, quota notes, modelos preferidos e capacidades sem alterar o binario.

## Profile local

Exemplo:

```yaml
schema_version: "1.0"
name: default
planner_provider: openai
planner_model: gpt-5.5
available_providers:
  - openai
  - google
available_models:
  - gpt-5.5
  - gpt-5.4
  - gpt-5.4-mini
  - gemini-3.1-pro-preview
  - gemini-3.1-pro-preview-customtools
  - gemini-3-flash-preview
  - gemini-3.1-flash-lite-preview
excluded_providers:
  - anthropic
model_registry:
  source: bundled
routing:
  prefer_available_only: true
  allow_provider_fallback: true
  require_confirmation_for_fallback: true
live_checks:
  require_before_plan: false
notes: []
```
