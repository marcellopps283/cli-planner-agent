# ADR 002 - Guardar roteamento por fit e risco

Data: 2026-05-09

## Status

Aceito

## Contexto

O planner recebe um registry com modelos ativos, scorecards por fit e risco, e
gera `suggested_model` por tarefa. Antes desta decisao, o harness validava que o
modelo existia no pool, mas aceitava uma sugestao ativa mesmo quando havia uma
opcao claramente superior para tarefas complexas.

Isso cria risco de underfitting: modelos baratos ou rapidos podem receber
arquitetura, refactor global, workflow agentico ou revisao critica apenas porque
o LLM economizou quota demais.

## Decisao

O harness continua deixando o LLM propor o modelo, mas aplica uma guarda
deterministica antes de gerar os artefatos:

- tarefas de alto risco nao podem ficar muito abaixo do melhor score ativo;
- tarefas medias respeitam o piso de risco detectado pelo proprio harness;
- tarefas `tiny_edit` de baixo risco podem continuar usando modelos utility;
- alternativas fracas sao filtradas antes de entrarem nos handoffs.

Quando a guarda troca o modelo, a razao fica registrada em `model_rationale`.

## Consequencias

Beneficios:

- reduz a chance de colocar modelo fraco em tarefa complicada;
- preserva economia de tokens para edicoes pequenas;
- torna o roteamento auditavel nos artefatos.

Custos:

- o planner pode ter sua escolha sobrescrita;
- os thresholds precisam acompanhar a evolucao do registry e benchmarks.

## Alternativas consideradas

- Apenas instruir melhor o prompt: rejeitado porque nao garante qualidade.
- Rejeitar o draft inteiro: seguro, mas piora a UX e aumenta custo de repair.
- Sempre escolher o topo do ranking: rejeitado porque perderia economia em
  tarefas simples.
