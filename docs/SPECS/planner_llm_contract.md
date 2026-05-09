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

## Execucao

`PlannerEngine` e a camada responsavel por chamada real ao provider. Ela sempre
recebe provider e model ID exatos do profile ativo ou do fallback aprovado:

- OpenAI/Codex: `codex exec -m <model>`
- Google/Gemini: `gemini -m <model> -p ...`
- Anthropic/Claude: `claude -p ... --model <model>`

O primeiro retorno e parseado com `PlannerDraftSchema`. Se a resposta nao for
JSON valido ou quebrar o contrato, o engine faz uma tentativa de reparo com um
prompt curto contendo o erro e a resposta invalida truncada. Falhas de provider
ou schema sao expostas com os attempts para auditoria e fallback.

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
      "model_rationale": "why this exact model fits the task",
      "acceptable_alternatives": ["other-active-model-id"],
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
- O harness pode corrigir `suggested_model` quando a escolha estiver abaixo do
  score minimo aceitavel para o fit/risco da tarefa.
- `model_rationale` deve explicar a escolha usando fit, risco, contexto, custo,
  latencia, benchmark ou disponibilidade.
- `acceptable_alternatives`, quando informado, so pode conter model IDs ativos
  no pool do usuario e tambem passa pelo filtro de fit/risco.
- Providers excluidos pelo profile nao podem aparecer em tasks.
- Dependencias so podem apontar para tasks anteriores.
- IDs de task devem seguir `task-NNN-kebab-case`.
- Stack detectada e CLIs instalados nao autorizam framework/biblioteca nova.
  O planner deve preferir dependencias ja declaradas nos manifests do projeto.
- Framework, pacote, banco, build tool ou test framework novo so pode aparecer
  como decisao pendente de confirmacao quando o usuario nao tiver pedido isso
  explicitamente.
- Tasks geradas precisam passar em `blueprint lint`.
- `validationCommands` e `test_commands` sao normalizados para comandos
  reprodutiveis quando possivel. Exemplo: `pnpm typecheck` vira
  `corepack pnpm typecheck`; `pnpm test run tests/tui.test.ts` vira
  `corepack pnpm test tests/tui.test.ts`.
- O harness pode elevar `risk_level` quando detectar sinais de risco que o
  modelo subestimou: `src/tui.ts`, `src/cli.ts`, providers, planner engine,
  fallback, auth, chat unificado, checkboxes semanticas ou estado global.
- `allowed_paths` deve preferir arquivos/diretorios existentes do inventario.
  Novos paths sao permitidos, mas devem ser explicitamente justificados em
  `context_rules`; o lint avisa quando eles ainda nao existem.
- `blueprint plan --engine llm --fallback` deve tentar outro modelo ativo do
  pool antes do fallback deterministico, pedindo confirmacao no modo interativo.

## Preview e Apply

O preview aprovado pelo usuario e o contrato de escrita. Quando o planner LLM
gera um draft para preview, a TUI salva esse draft em `.blueprint/tui_sessions/`
e o apply usa o mesmo conteudo, sem chamar o planner novamente. Isso evita que
o usuario aprove uma decomposicao e receba outra nos arquivos finais.

## Fixtures

Fixtures de contrato vivem em `tests/fixtures/planner-drafts/`:

- `golden-valid.json`: exemplo aceito e lintavel.
- `unavailable-model.json`: exemplo rejeitado por sugerir modelo fora do pool.
- `invalid-fit.json`: exemplo rejeitado por `fit` invalido.
