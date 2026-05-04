# Spec - Commands

## Objetivo

Definir a superficie inicial da CLI.

## Superficie principal

### `blueprint`

Abre a TUI diretamente no chat `Plan / Actions`. Esta e a frente principal do
produto: onboarding, configuracoes, model pool, status, acoes operacionais e
inicio de planejamento em formato chat.

Opcoes:

- `--root <path>` escolhe o projeto alvo.
- `--view <view>` abre uma tela inicial especifica; `--view main` abre o menu.
- `--json` imprime o modelo do dashboard para automacao.

## MVP commands

### `blueprint init`

Inicializa configuracao local do planner no projeto alvo.

### `blueprint providers`

Lista providers configurados e modelos conhecidos. Com `--models`, tambem mostra
o esforco de raciocinio default registrado para cada modelo.

### `blueprint profile init`

Cria `.blueprint/profile.yaml` com o pool local de providers, pool de modelos
exatos, planner escolhido, modelo mestre e regras de fallback.

Exemplo para ambiente sem cota Claude:

```bash
blueprint profile init --providers openai,google --planner-provider openai
```

Para restringir o roteamento a modelos especificos:

```bash
blueprint profile init \
  --providers openai,google \
  --models gpt-5.5,gemini-3.1-pro-preview,gemini-3.1-flash-lite-preview \
  --planner-provider openai \
  --planner-model gpt-5.5
```

Quando usado com `--project-registry`, tambem cria
`.blueprint/model_registry.yaml` a partir do registry bundled se o arquivo ainda
nao existir. Assim o par `profile init --project-registry` e `profile validate`
funciona sem exigir um `registry export` manual antes.

### `blueprint profile show`

Mostra o profile local ativo.

### `blueprint profile validate`

Valida que o planner pertence ao pool, que o modelo existe no registry ativo e
que fallback exige confirmacao humana.

### `blueprint registry export`

Exporta o registry bundled para `.blueprint/model_registry.yaml`, permitindo
customizacao por projeto sem editar o codigo do CLI.

### `blueprint registry show`

Lista modelos do registry bundled ou, com `--project`, do registry local,
incluindo provider, tier, status, access mode e esforco default.

### `blueprint registry refresh`

Sincroniza `.blueprint/model_registry.yaml` com o registry bundled atual,
substituindo entradas conhecidas por suas versoes novas e preservando IDs
customizados que nao existem no bundled.

Opcoes:

- `--dry-run` mostra `added`, `updated` e `preserved_custom` sem escrever.
- `--path <path>` permite atualizar um registry alternativo relativo a
  `.blueprint/`.

### `blueprint registry validate`

Valida schema, IDs duplicados e orientacoes minimas do registry local.

### `blueprint auth doctor`

Verifica se os CLIs oficiais estao instalados e, quando possivel, autenticados.

Opcoes:

- `--provider <id>` limita a checagem a `openai`, `anthropic` ou `google`.
- `--live` executa smokes configurados que podem consumir quota do provider.
- `--timeout-ms <number>` ajusta o timeout dos smokes live.

Regra do MVP: o Gemini permanece `not_checked` no modo padrao. A validacao real
usa `blueprint auth doctor --provider google --live`, que deve rodar em um
diretorio temporario vazio, em modo read-only/plan e com `--skip-trust` para o
Gemini headless. O mesmo padrao de `--live` tambem valida inferencia de
OpenAI/Codex e Anthropic/Claude quando solicitado.

### `blueprint doctor`

Analisa o projeto alvo:

- docs canonicos encontrados;
- arquivos bloqueados por seguranca;
- manifests detectados;
- riscos de contexto;
- readiness para planejamento.

### `blueprint plan`

Abre o fluxo investigativo, conversa com o usuario, apresenta um resumo executivo
e gera `.blueprint/`.

MVP atual:

- usa `@clack/prompts` para perguntas simples;
- exige profile valido antes de planejar;
- respeita `available_models`, `available_providers` e `model_registry`;
- envia ao planner um inventario compacto com stack detectada, scripts,
  top-level dirs, arquivos priorizados e headings dos docs canonicos;
- gera `architecture.md`, `assumptions.md`, `decisions.md`, `risks.md`,
  `dependencies_graph.json`, `integration_guide.md` e `tasks/*.md`;
- aceita `--answers <path>` para execucao nao interativa;
- aceita `--engine deterministic|llm`, onde `llm` chama o planner provider
  ativo via CLI oficial e valida a resposta com schema antes de escrever;
- no engine `llm`, passa o model ID exato para o CLI oficial do provider e faz
  uma tentativa de reparo quando a resposta nao passa no contrato JSON;
- em modo interativo, monta um preview em memoria com task graph e
  `suggested_model`, justificativa e alternativas por task, pede confirmacao e
  so entao escreve os handoffs;
- aceita `--fallback` para pedir confirmacao e tentar outro modelo ativo do
  pool antes de usar o plano deterministico caso o planner LLM falhe;
- aceita `--planner-timeout-ms <number>` para chamadas LLM;
- aceita `--yes` para pular confirmacao e `--force` para substituir tasks
  existentes.

### `blueprint lint`

Valida `.blueprint/` contra schemas e regras de conflito.

### `blueprint revise`

Recebe uma mudanca e classifica o tipo de revisao antes de editar artefatos.

MVP atual:

- aceita `--change <text>` ou `--file <path>`;
- usa Smart Grep lexical sobre `.blueprint/`, task metadata e grafo;
- classifica em `local_doc`, `task_local`, `graph_local`,
  `architecture_subtree` ou `global_replan`;
- grava um registro auditavel em `.blueprint/revisions/*.json`;
- aceita `--dry-run` para nao escrever e `--json` para output estruturado;
- aceita `--apply` para aplicar revisoes `local_doc` seguras em um unico
  documento markdown gerenciado por `.blueprint/`;
- aceita `--apply` para aplicar revisoes `task_local` em uma unica task,
  preservando `id`, `dependencies`, blocos XML e `blueprint lint`;
- aceita `--apply` para aplicar revisoes `graph_local` quando a mudanca
  explicita uma operacao de dependencia entre duas tasks;
- aceita `--apply-timeout-ms <number>` para chamadas LLM de apply.

### `blueprint export`

Empacota os handoffs em formato transportavel.

MVP atual:

- valida `.blueprint/` com `blueprint lint` antes de exportar;
- grava uma pasta de export em `.blueprint/exports/<project>-blueprint-<timestamp>`
  por padrao;
- aceita `--out <path>` para escolher outro diretorio;
- aceita `--force` para substituir o diretorio de saida;
- inclui `blueprint.yaml`, docs de arquitetura, grafo, guia de integracao,
  `model_registry.yaml` quando existir, e `tasks/*.md`;
- exclui `profile.yaml`, `revisions/*.json`, `tui_sessions/*.json` e
  `exports/**` por padrao;
- aceita `--include-profile` e `--include-revisions` quando o usuario quiser
  carregar contexto local/auditavel junto;
- grava `EXPORT_MANIFEST.json` com arquivos incluidos, excluidos e warnings do
  lint;
- aceita `--allow-invalid` apenas para exportar artefatos mesmo com erro de
  lint.

### `blueprint tui`

Abre o dashboard Ink do blueprint atual.

MVP atual:

- le profile, inventario de contexto, lint, manifest, grafo, tasks e exports;
- abre no chat `actions` e deixa `main menu`, `overview`, `tasks`, `graph` e
  `providers` sob demanda;
- o `main menu` e invocado por `/menu`, `--view main` ou `Esc` a partir do
  chat;
- mostra onboarding quando o diretorio atual ainda nao tem `.blueprint/`;
- mostra o diretorio atual no onboarding; `Enter` mantem o diretorio e `c`
  permite escolher outro caminho dentro da TUI;
- mostra status de profile, blueprint, contexto e tasks;
- lista tasks, dependencias, provider pool, model pool e chat operacional;
- a tela `actions` e a superficie padrao: abre como landing "What are we
  planning today?" e vira workbench depois da primeira mensagem;
- o workbench exibe chat, status line, historico recente, input permanente e
  artefato de planejamento com checklist/progresso;
- aceita slash commands locais: `/plan`, `/providers`, `/models`, `/registry`,
  `/lint`, `/export`, `/revise`, `/auth`, `/auth-live`, `/help` e `/menu`;
- filtra slash commands quando o input comeca com `/` e completa a primeira
  sugestao com `Tab`;
- mostra overlays de foco para perguntas de planejamento, confirmacoes, model
  pool e revise;
- texto livre no chat inicia planejamento; `/plan [brief]` faz o mesmo de forma
  explicita;
- o intake e adaptativo: brief curto aprofunda perguntas; brief rico pula
  campos derivaveis e pede apenas lacunas estruturais;
- o planejamento usa o PlannerEngine LLM do profile, mantendo o modo
  deterministico apenas para fallback, automacao e testes;
- quando o PlannerEngine LLM falha dentro da TUI, o resultado sugere o proximo
  modelo ativo ou o fallback deterministico e pede confirmacao antes de tentar;
- `/models` aceita IDs exatos separados por virgula ou `all` para
  voltar aos defaults dos providers ativos, e regrava `available_models` em
  `profile.yaml`;
- `refresh registry` pede confirmacao e roda `blueprint registry refresh`;
- pede confirmacao antes de `setup project`; quando confirmado, cria arquivos
  locais faltantes (`.blueprint/`, `profile.yaml`, `model_registry.yaml`) sem
  chamada de modelo;
- captura texto para `revise`, roda preview/dry-run, mostra classificacao e so
  permite apply depois de confirmacao;
- registra cada acao executada em `.blueprint/tui_sessions/*.json`;
- exige confirmacao na TUI antes de `auth doctor --live`, pois pode consumir
  quota de provider;
- calcula uma proxima acao operacional;
- aceita `--view <view>` para diagnostico ou automacao, mas a jornada normal
  abre em `actions`;
- aceita `--json` para imprimir o modelo de dashboard sem renderizar Ink.

## Futuro 2.0

### `blueprint run`

Executa workers conforme grafo.

### `blueprint status`

Mostra andamento e retornos normalizados.

### `blueprint integrate`

Ajuda a costurar retornos de workers e validar criterios de aceite.
