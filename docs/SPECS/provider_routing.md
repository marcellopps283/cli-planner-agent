# Spec - Provider Routing

## Objetivo

Permitir que o planner mestre recomende o melhor worker para cada tarefa usando
apenas os provedores selecionados pelo usuario.

## MVP

Decisao por LLM com banco atualizavel de modelos.

Entradas:

- lista de providers disponiveis;
- modelos/capacidades selecionados;
- tipo da task;
- complexidade;
- risco;
- contexto necessario;
- privacidade;
- quota/custo conhecidos.

O pool ativo vem de `.blueprint/profile.yaml`. Providers sem cota, ausentes ou
desmarcados pelo usuario ficam no registry, mas nao entram em `available_providers`
nem podem ser escolhidos pelo roteador para novas tasks.

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
    task_fit:
      planning: 0.98
      coding_heavy: 0.95
      review: 0.9
    context_window: 1000000
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
- complexidade;
- contexto;
- velocidade;
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
planner_model: openai-codex-default
available_providers:
  - openai
  - google
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
