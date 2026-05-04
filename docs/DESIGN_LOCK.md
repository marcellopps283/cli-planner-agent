# DESIGN LOCK - CLI Planner-Agent

> Status: draft locked v0.1 (2026-05-02).
> Mudancas estruturais exigem ADR.

## 1. Produto

CLI/TUI para atuar como harness de planejamento em fluxos de desenvolvimento
com IA. Ele abre como uma superficie unica de operacao, configura providers e
modelos no inicio, investiga requisitos em um fluxo tipo chat, entende o
contexto essencial do projeto, quebra o trabalho em tarefas, monta um grafo de
dependencias e gera handoffs isolados para agentes executores.

## 2. Usuarios alvo

- Desenvolvedores individuais.
- Times pequenos que usam varios provedores de IA.
- Usuarios com assinaturas consumer ou dev tools ja autenticadas localmente.

## 3. Versoes

### 1.0 - Planner

- Abre a TUI por padrao com `blueprint`.
- Faz onboarding obrigatorio de diretorio, providers, modelos e planner.
- Usa um provedor/modelo como planner mestre.
- Mostra um painel operacional para configuracoes, status, metricas e artefatos.
- Usa uma experiencia tipo chat quando o usuario inicia uma tarefa de
  planejamento.
- Gera `.blueprint/` com arquitetura, grafo e tasks.
- Recomenda modelo/worker por tarefa.
- Mostra as atribuicoes de modelo por task antes de gerar os handoffs e pede
  confirmacao do usuario.
- Nao executa codigo nem gerencia workers.

### 2.0 - Supervisor

- Executa workers dentro do proprio CLI.
- Acompanha status, falhas, retornos e integracao.
- Usa `codex exec`, `claude -p`, `gemini -p` ou interfaces equivalentes.
- Mantem o app como superficie unica para codar com IA.

## 4. Principios

1. Auth oficial antes de conveniencia.
2. Artefatos versionaveis antes de memoria implicita.
3. Contexto minimo suficiente antes de leitura total.
4. Planejamento explicito antes de execucao.
5. Schemas antes de texto livre.
6. Replanejamento cirurgico quando seguro; global quando necessario.
7. Usuario controla provedores, custos, privacidade e fallback.
8. Uma unica frente de uso antes de multiplos comandos soltos.

## 5. Nao objetivos do MVP

- Capturar cookies ou tokens de sessoes web.
- Executar workers automaticamente.
- Manter estado continuo de execucao.
- Indexar semanticamente repositorios com embeddings locais.
- Suportar tarefas nao-code como primeira superficie.

## 6. Auth e provedores

O CLI deve tratar OpenAI, Anthropic e Google como providers plugaveis.
No MVP, a integracao preferida e via CLIs oficiais instalados no ambiente do
usuario:

- OpenAI/Codex: `codex`
- Anthropic/Claude Code: `claude`
- Google/Gemini CLI: `gemini`

O app verifica disponibilidade, status de auth e modo nao interativo quando
possivel. Se o usuario nao tiver um provedor, ele nao entra no pool.

O onboarding deve apresentar providers primeiro e depois, uma tela por provider,
os modelos suportados. O usuario pode selecionar todos ou marcar uma pool fina.

## 7. Roteamento

O planner mestre recebe um banco atualizavel de modelos/capacidades selecionados
pelo usuario. No MVP, a decisao e feita por LLM com regras e schema. Futuramente,
vira hibrido: LLM + scoring deterministico.

O banco comparativo e quase interno. A TUI mostra os IDs necessarios para
configuracao, mas a decisao de roteamento deve priorizar custo-beneficio,
evitando overfitting e underfitting.

Dimensoes minimas do banco:

- `provider`
- `model`
- `access_mode`
- `task_fit`
- `reasoning_efforts`
- `default_reasoning_effort`
- `context_window`
- `strengths`
- `weaknesses`
- `latency_class`
- `quota_notes`
- `privacy_notes`
- `cost_class`
- `recommended_uses`
- `avoid_for`

## 8. Contexto

O CLI nao deve jogar o repo inteiro no planner. Ele deve construir um inventario:

1. arquivos canonicos detectados;
2. arvore resumida;
3. manifests e configs;
4. docs de arquitetura;
5. arquivos solicitados sob demanda.

Secrets e arquivos ignorados sao bloqueados por padrao.

## 9. Artefatos

O diretorio de saida padrao e `.blueprint/`.

Artefatos obrigatorios:

- `blueprint.yaml`
- `architecture.md`
- `dependencies_graph.json`
- `tasks/*.md`
- `integration_guide.md`

Artefatos recomendados:

- `assumptions.md`
- `decisions.md`
- `risks.md`

## 10. Tasks

Cada task deve conter frontmatter YAML para maquina e blocos XML para o worker.
O objetivo e permitir tanto leitura humana quanto consumo automatizado futuro.

Campos minimos:

- id
- title
- suggested_model
- dependencies
- parallel_group
- allowed_paths
- forbidden_paths
- acceptance_criteria
- test_commands
- risk_level

Blocos XML minimos:

- `<task_objective>`
- `<suggested_model>`
- `<context_rules>`
- `<execution_prompt>`
- `<acceptance_contract>`

## 11. Smart revise

Atualizacoes pos-planejamento passam por classificacao:

- `local_doc`: reescreve um documento.
- `task_local`: reescreve uma task e seus metadados.
- `graph_local`: reescreve task + arestas do grafo.
- `architecture_subtree`: replaneja uma area.
- `global_replan`: stack, arquitetura ou premissas centrais mudaram.

Mudancas como Postgres para MongoDB normalmente sao `architecture_subtree` ou
`global_replan`, nao edicao isolada.
