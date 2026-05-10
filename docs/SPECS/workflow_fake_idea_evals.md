# Spec - Fake Idea Workflow Evaluations

## Objetivo

Manter uma bateria pequena de ideias artificiais para verificar se o harness:

- conversa em modo brainstorming quando faltam decisoes;
- nao transforma stack/local tooling em decisao implicita;
- distribui subtarefas por complexidade sem gravar `suggested_model`
  inadequado/fraco;
- recusa handoffs quando todo modelo ativo seria uma sugestao inadequada para a
  subtarefa.

## Cenarios cobertos

Os cenarios vivem em `tests/workflow-evals.test.ts`.

1. CRM greenfield com stack indefinida.
   - Esperado: `agent-workflow` fica em `ask_user`, sem `preview_plan`.
   - O prompt deve incentivar opcoes com tradeoffs.

2. Plano misto com copy edit, fixture mecanica, TUI e roteamento.
   - Copy edit: modelo barato adequado (`tiny_edit`).
   - TUI/refactor: modelo nao-utility.
   - Arquitetura/routing: modelo frontier forte.
   - Alternativas tambem precisam passar no piso de adequacao.
   - O handoff final deve gravar o `suggested_model` corrigido, nao a sugestao
     fraca recebida no draft.

3. Pool somente Google.
   - Esperado: upgrade para `gemini-3.1-pro-preview`.
   - Nunca vaza para OpenAI/Anthropic fora do pool ativo.

4. Pool em que todo modelo seria inadequado para a subtarefa.
   - Esperado: preview falha com erro explicito.
   - O app deve pedir modelo mais forte ou quebra/reducao de escopo.

## Regra de Produto

O planner pode propor qualquer stack no brainstorm. A trava so aparece quando o
sistema vai cristalizar handoffs: subtarefa concreta precisa de `suggested_model`
concreto e adequado dentro do pool ativo.
