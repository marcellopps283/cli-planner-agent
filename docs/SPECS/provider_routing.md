# Spec - Provider Routing

## Objetivo

Permitir que o planner mestre recomende o melhor worker para cada tarefa usando
apenas os modelos exatos selecionados pelo usuario. Providers continuam sendo a
fronteira de autenticacao/CLI, mas a unidade de roteamento e o model ID.

## MVP

Decisao por LLM com banco atualizavel de modelos e scorecards
deterministicos de apoio. O LLM escolhe a atribuicao final, mas recebe uma
ordem recomendada por tipo de tarefa e risco para reduzir overfitting e
underfitting.

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
- `model_rationale` precisa citar fit, risco, contexto, custo, latencia,
  benchmarks ou disponibilidade quando relevante.

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

## Scorecards hibridos

O prompt do planner inclui `routing_scorecards` para cada fit conhecido. Cada
scorecard tem:

- `low_risk_order`: prioriza fit suficiente, custo, latencia e estabilidade;
- `high_risk_order`: prioriza fit, tier, contexto e confiabilidade;
- `score`, `fit`, `tier`, `latency` e `cost` por modelo.

Formula conceitual:

```text
low risk  = fit*0.45 + cost*0.25 + speed*0.15 + stability*0.10 + context*0.05
high risk = fit*0.55 + tier*0.20 + context*0.15 + stability*0.05 + speed*0.05
```

O scorecard e uma recomendacao com guarda deterministica. O LLM pode escolher
diferente quando justificar com benchmark, contexto, quota ou requisito da
tarefa, mas o CLI valida duas coisas antes de aceitar:

- o modelo escolhido precisa existir no pool ativo;
- a escolha nao pode ficar muito abaixo do melhor score ativo para o fit/risco.

Quando o planner subestima uma tarefa complexa ou superestima uma tarefa
`tiny_edit` simples, o CLI troca para o melhor modelo do scorecard e registra a
correcao no `model_rationale`. Alternativas tambem passam pelo mesmo filtro para
evitar fallback fraco em tarefas de alto risco.

O score relativo nao basta quando o pool ativo inteiro produziria uma sugestao
fraca para a subtarefa. Antes de gerar handoffs, o CLI aplica um piso absoluto
de adequacao:

- tarefas `risk >= 8` precisam de fit alto para o tipo da tarefa;
- tarefas `risk >= 5` que nao sejam `tiny_edit` nao podem ser entregues a tier
  `utility`;
- se nenhum modelo ativo atingir o piso, o preview falha em vez de gravar
  `suggested_model` inadequado; o usuario precisa habilitar modelo mais forte ou
  quebrar/rebaixar o escopo da tarefa.

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
planner_reasoning_effort: xhigh
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
model_reasoning_efforts:
  gpt-5.5: xhigh
  gpt-5.4: high
  gpt-5.4-mini: medium
  gemini-3.1-pro-preview: high
  gemini-3.1-pro-preview-customtools: high
  gemini-3-flash-preview: medium
  gemini-3.1-flash-lite-preview: medium
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
