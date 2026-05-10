# Spec - Fake Idea Workflow Evaluations

## Objetivo

Manter uma bateria pequena de ideias artificiais para verificar se o harness:

- conversa em modo brainstorming quando faltam decisoes;
- nao transforma stack/local tooling em decisao implicita;
- distribui tarefas por complexidade usando modelos capazes;
- recusa handoffs quando o pool ativo nao tem modelo suficiente.

## Cenarios cobertos

Os cenarios vivem em `tests/workflow-evals.test.ts`.

1. CRM greenfield com stack indefinida.
   - Esperado: `agent-workflow` fica em `ask_user`, sem `preview_plan`.
   - O prompt deve incentivar opcoes com tradeoffs.

2. Plano misto com copy edit, fixture mecanica, TUI e roteamento.
   - Copy edit: modelo barato capaz (`tiny_edit`).
   - TUI/refactor: modelo nao-utility.
   - Arquitetura/routing: modelo frontier forte.
   - Alternativas tambem precisam passar no piso de capacidade.

3. Pool somente Google.
   - Esperado: upgrade para `gemini-3.1-pro-preview`.
   - Nunca vaza para OpenAI/Anthropic fora do pool ativo.

4. Pool sem modelo capaz.
   - Esperado: preview falha com erro explicito.
   - O app deve pedir modelo mais forte ou quebra/reducao de escopo.

## Regra de Produto

O planner pode propor qualquer stack no brainstorm. A trava so aparece quando o
sistema vai cristalizar handoffs: tarefa concreta precisa de modelo concreto e
capaz dentro do pool ativo.
