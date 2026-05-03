# AGENTS.md - instrucoes para agentes neste repo

Leia este arquivo primeiro.

## 30 segundos

- Projeto: CLI Planner-Agent, nome final pendente.
- Objetivo: gerar planos e handoffs rigorosos para projetos de codigo.
- MVP 1.0: planner puro, sem executar workers.
- V2: planner + supervisor de workers via CLIs oficiais.
- Stack: TypeScript, Node 20+, TUI rica, schemas com Zod.
- Auth: usar CLIs oficiais (`codex`, `claude`, `gemini`) como ponte. Nao capturar cookies.

## Ordem de leitura

1. `docs/DESIGN_LOCK.md`
2. `docs/MVP_ROADMAP.md`
3. `docs/OPERATIONAL_SOURCES.md`
4. `docs/SPECS/artifact_contract.md`
5. `docs/SPECS/context_inventory.md`
6. `docs/SPECS/provider_routing.md`
7. `docs/ADR/001-use-official-cli-auth-bridges.md`

## Regras duras

- Nao implementar captura de cookie/session token de plataformas web.
- Nao enviar secrets do projeto alvo para provedores sem confirmacao explicita.
- Nao ler o repo inteiro indiscriminadamente; usar inventario, ignores e leitura sob demanda.
- Toda mudanca estrutural precisa de ADR.
- Todo artefato `.blueprint/` deve ser validavel por schema.
- Toda task deve ter ownership de paths para evitar conflito entre workers.

## Antes de entregar

- `pnpm test` passando quando dependencias existirem.
- `pnpm typecheck` passando quando dependencias existirem.
- Docs atualizados se contrato, UX ou artefatos mudarem.
- ADR novo para mudanca em autenticacao, formato de artefato, roteamento ou execucao de workers.

