# Fontes Operacionais

## Hierarquia

1. `docs/DESIGN_LOCK.md`
2. specs em `docs/SPECS/`
3. ADRs em `docs/ADR/`
4. `docs/MVP_ROADMAP.md`
5. codigo e testes
6. `docs/poc_results/`

Se houver conflito, o `DESIGN_LOCK` e a spec relevante vencem resumo, roadmap
ou comentario antigo.

## Arquivos vivos

- `docs/DESIGN_LOCK.md`: contrato do produto.
- `docs/MVP_ROADMAP.md`: progresso e escopo por fase.
- `docs/SPECS/*.md`: contratos por componente.
- `docs/ADR/*.md`: decisoes estruturais.
- `README.md`: entrada humana curta.
- `AGENTS.md`: orientacao para agentes.

## Ritual de mudanca

1. Alterar codigo/docs.
2. Atualizar spec se contrato mudou.
3. Criar ADR se decisao estrutural mudou.
4. Atualizar roadmap se progresso ou escopo mudou.
5. Adicionar POC result quando houver evidencia real.

