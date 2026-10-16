# AstCall

Painel de monitoramento em tempo real para **Asterisk 20 e 22** (AMI + WebSocket), inspirado no MonAst.
Funciona de forma **standalone** ou como **módulo do AzCall**. Veja `CLAUDE.md` e `docs/ROADMAP.md`.

## Estrutura

```
apps/realtime/   # backend Node.js (AMI, estado, WebSocket)
apps/web/        # frontend Vue 3 (Web Component + SPA standalone)
packages/shared/ # tipos e contratos compartilhados
config/          # servers.example.json (copie para servers.json)
docs/            # roadmap e documentação
```

## Primeiros passos

Requisitos: Node.js 22 ou superior.

```bash
npm install
cp .env.example .env                          # ajuste credenciais AMI
cp config/servers.example.json config/servers.json
npm run dev:realtime                          # backend (porta 8090)
npm run dev:web                               # frontend (http://localhost:5173)
```

## Comandos úteis

| Comando             | O que faz                              |
| ------------------- | -------------------------------------- |
| `npm run typecheck` | Verifica tipos em todos os pacotes     |
| `npm test`          | Executa os testes (Vitest)             |
| `npm run lint`      | ESLint em todo o monorepo              |
| `npm run format`    | Formata o código com Prettier          |
| `npm run build`     | Gera `dist/` de shared, realtime e web |
