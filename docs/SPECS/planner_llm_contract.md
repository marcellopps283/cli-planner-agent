# Spec - Planner LLM Contract

## Objetivo

Definir o contrato entre o CLI e o modelo planner quando `blueprint plan` roda
com `--engine llm`.

## Regra central

O provider nunca recebe o repositorio inteiro. O CLI monta um pacote compacto com:

- respostas investigativas do usuario;
- profile ativo;
- modelos ativos do registry;
- inventario do projeto;
- padroes bloqueados.

O provider deve responder somente JSON. O CLI valida esse JSON antes de escrever
qualquer arquivo em `.blueprint/`.

## Schema resumido

```json
{
  "schema_version": "1.0",
  "overview": "short plan overview",
  "assumptions": ["..."],
  "decisions": ["..."],
  "risks": ["..."],
  "integration_notes": ["..."],
  "tasks": [
    {
      "id": "task-001-kebab-case",
      "title": "...",
      "objective": "...",
      "suggested_model": "active-model-id",
      "fit": "planning",
      "dependencies": [],
      "allowed_paths": [],
      "forbidden_paths": [".env"],
      "risk_level": 3,
      "test_commands": [],
      "context_rules": ["..."],
      "execution_prompt": "...",
      "acceptance_contract": ["..."]
    }
  ]
}
```

## Validacoes obrigatorias

- `fit` deve ser um dos valores conhecidos: `planning`, `architecture`,
  `coding_heavy`, `review`, `refactor`, `tiny_edit`, `long_context`.
- `suggested_model`, quando informado, deve existir no pool ativo.
- Providers excluidos pelo profile nao podem aparecer em tasks.
- Dependencias so podem apontar para tasks anteriores.
- IDs de task devem seguir `task-NNN-kebab-case`.
- Tasks geradas precisam passar em `blueprint lint`.

## Fixtures

Fixtures de contrato vivem em `tests/fixtures/planner-drafts/`:

- `golden-valid.json`: exemplo aceito e lintavel.
- `unavailable-model.json`: exemplo rejeitado por sugerir modelo fora do pool.
- `invalid-fit.json`: exemplo rejeitado por `fit` invalido.
