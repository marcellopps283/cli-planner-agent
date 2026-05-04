# Spec - Context Inventory

## Objetivo

Montar contexto suficiente sem ler ou enviar o repositorio inteiro.

## Camadas

### 1. Canonical scan

Arquivos buscados primeiro:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- `docs/DESIGN_LOCK.md`
- `docs/MVP_ROADMAP.md`
- `docs/ADR/`
- `.gitignore`

### 2. Tree inventory

Gerar arvore resumida com:

- path
- tipo
- tamanho
- extensao
- markers relevantes
- stack detectada
- scripts de validacao conhecidos
- top-level dirs
- headings dos documentos canonicos

Respeitar `.gitignore` e ignores internos.

### 3. Symbol and heading scan

Extrair sem embeddings:

- headings Markdown;
- nomes de scripts em manifests;
- exports/imports simples;
- nomes de testes;
- top-level dirs.

### 4. On-demand read

Se o planner precisar de arquivo especifico, pedir confirmacao quando:

- o arquivo parece conter segredo;
- o path esta bloqueado;
- o arquivo e muito grande;
- o arquivo nao esta no escopo declarado.

## Bloqueios padrao

- `.env*`
- `*.pem`
- `*.key`
- `id_rsa*`
- `node_modules/`
- `.git/`
- `dist/`
- `build/`
- coverage/cache directories

## Saida

O inventario vira input do planner e tambem pode ser persistido como:

```text
.blueprint/context_inventory.json
```

Somente metadados e resumos curtos devem ser persistidos.

## Status implementado

`blueprint doctor` e o pacote enviado ao PlannerEngine ja incluem:

- `stack`: inferida por manifests, extensoes e configs como `tsconfig.json`;
- `scripts`: scripts do `package.json`;
- `topLevelDirs`: diretorios raiz relevantes;
- `inventoryFiles`: ate 80 paths priorizados com extensao, tamanho e markers;
- `markdownHeadings`: headings curtos dos docs canonicos.
