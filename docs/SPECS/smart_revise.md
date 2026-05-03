# Spec - Smart Revise

## Objetivo

Atualizar planos gerados sem replanejar tudo quando a mudanca e local.

## Classificacao

- `local_doc`: afeta um documento.
- `task_local`: afeta uma task.
- `graph_local`: afeta uma task e dependencias proximas.
- `architecture_subtree`: afeta uma area do plano.
- `global_replan`: muda premissa central.

## Heuristica MVP

Usar busca lexical e metadados:

- nomes de tecnologias;
- paths em tasks;
- headings;
- dependencies graph;
- assumptions;
- decisions;
- riscos.

Sem embeddings no MVP.

## Comando MVP

```bash
blueprint revise --change "Adicione teste de contrato na task 004"
blueprint revise --change "Adicione criterio de lint no acceptance_contract da task 004" --apply
blueprint revise --change "Faça task-004 depender também da task-002" --apply
blueprint revise --file ./change-request.txt --json
blueprint revise --change "Mude o banco para MongoDB" --dry-run
blueprint revise --change "Atualize integration_guide.md" --apply
```

Saida padrao:

- classificacao;
- confianca;
- arquivos afetados provaveis;
- tasks afetadas provaveis;
- acao recomendada;
- racional da classificacao.

Sem `--dry-run`, o CLI grava um registro em `.blueprint/revisions/*.json`.

No MVP, `--apply` e permitido quando a classificacao for `local_doc` com um
unico documento markdown gerenciado por `.blueprint/`, ou `task_local` com uma
unica task afetada. Em `task_local`, o CLI rejeita respostas que mudem `id`,
`dependencies` ou removam blocos XML obrigatorios, e so aceita a escrita se
`blueprint lint` continuar sem erros. Em `graph_local`, o apply automatico e
restrito a operacoes explicitas de dependencia entre duas tasks, atualizando
`dependencies_graph.json` e o frontmatter da task alvo com rollback em caso de
erro ou ciclo. Outros tipos de revisao ficam registrados como `unsupported` para
aplicacao automatica.

## Exemplos

- "Renomeie o modulo X para Y": `task_local` ou `graph_local`.
- "Mude o banco de Postgres para MongoDB": `architecture_subtree` ou `global_replan`.
- "Adicione teste de contrato na task 004": `task_local`.

## UX

MVP pode aplicar direto apos confirmacao geral do usuario.
Versao avancada deve mostrar arquivos provavelmente afetados antes de reescrever.
