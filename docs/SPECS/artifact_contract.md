# Spec - Artifact Contract

## Objetivo

Definir o formato da pasta `.blueprint/` gerada no projeto do usuario.

## Estrutura

```text
.blueprint/
  profile.yaml
  model_registry.yaml
  blueprint.yaml
  architecture.md
  assumptions.md
  decisions.md
  risks.md
  dependencies_graph.json
  integration_guide.md
  exports/
    cli-planner-agent-blueprint-2026-05-02T15-00-00-000Z/
      EXPORT_MANIFEST.json
  revisions/
    2026-05-02T15-00-00-000Z-task_local.json
  tui_sessions/
    2026-05-02T15-00-00-000Z-lint-1a2b3c4d.json
  tasks/
    001-task-name.md
```

## `blueprint.yaml`

Metadados do plano.

Campos:

- `schema_version`
- `project_name`
- `created_at`
- `planner_provider`
- `planner_model`
- `available_providers`
- `artifact_root`
- `status`

## `profile.yaml`

Configuracao local do usuario para o projeto.

Campos:

- `schema_version`
- `name`
- `planner_provider`
- `planner_model`
- `available_providers`
- `excluded_providers`
- `model_registry`
- `routing`
- `live_checks`
- `notes`

## `model_registry.yaml`

Registry editavel por projeto. Opcional no MVP; quando ausente, o profile usa o
registry bundled.

Campos:

- `schema_version`
- `models`

## `revisions/*.json`

Registros auditaveis de `blueprint revise`.

Campos:

- `schema_version`
- `created_at`
- `change`
- `classification`
- `confidence`
- `affected_files`
- `affected_tasks`
- `rationale`
- `recommended_action`
- `application`

## `tui_sessions/*.json`

Registros auditaveis de acoes disparadas pela TUI. Estes arquivos nao substituem
`revisions/*.json`: revision continua sendo o historico canonico de mudancas de
plano; `tui_sessions` registra operacoes de interface como lint, export, auth
doctor e preview/apply de revise.

Campos:

- `schema_version`
- `session_id`
- `created_at`
- `root`
- `action`
- `result`

Cada `action` registra:

- `id`
- `command`
- `change`, quando aplicavel
- `apply`

Cada `result` registra:

- `status`
- `summary`
- `lines`
- `can_apply`, quando aplicavel

## `exports/*/EXPORT_MANIFEST.json`

Manifesto do pacote transportavel gerado por `blueprint export`.

Campos:

- `schema_version`
- `created_at`
- `source_project`
- `source_blueprint`
- `lint_warnings`
- `included_files`
- `excluded_files`

Export padrao inclui handoffs e documentos necessarios para execucao manual:

- `blueprint.yaml`
- `architecture.md`
- `assumptions.md`
- `decisions.md`
- `risks.md`
- `dependencies_graph.json`
- `integration_guide.md`
- `model_registry.yaml`, quando existir
- `tasks/*.md`

Export padrao exclui dados locais ou historico auditavel que podem ser
transportados so sob opt-in:

- `profile.yaml`
- `revisions/*.json`
- `tui_sessions/*.json`
- `exports/**`

## `dependencies_graph.json`

Grafo estrito de execucao.

Campos:

- `schema_version`
- `nodes`
- `edges`
- `parallel_groups`

Cada node:

- `id`
- `title`
- `task_file`
- `depends_on`
- `allowed_paths`
- `risk_level`

## Task markdown

Formato:

```markdown
---
id: task-001
title: Example
suggested_model: claude-opus-4-7
dependencies: []
parallel_group: foundation
allowed_paths:
  - src/example.ts
forbidden_paths:
  - .env
risk_level: 3
test_commands:
  - pnpm test
---

<task_objective>
...
</task_objective>

<suggested_model>
...
</suggested_model>

<context_rules>
...
</context_rules>

<execution_prompt>
...
</execution_prompt>

<acceptance_contract>
...
</acceptance_contract>
```

## Validacao

`blueprint lint` deve falhar quando:

- YAML obrigatorio esta ausente.
- `profile.yaml`, quando existir, referencia planner/model fora do pool ativo.
- `model_registry.yaml`, quando usado, possui IDs duplicados ou schema invalido.
- XML obrigatorio esta ausente.
- `dependencies_graph.json` aponta para task inexistente.
- duas tasks paralelas escrevem no mesmo path.
- task nao possui criterio de aceite.
- provider/model recomendado nao existe no registry selecionado.
