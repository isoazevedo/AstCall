# Testes de replay e de carga

> Última revisão: 2026-10-17

## Replay (automático, roda com `npm test`)

As gravações reais do laboratório (`apps/realtime/test/fixtures/`) são reproduzidas contra o
estado do backend:

- `test/state/scenarios.test.ts`: o estado em pontos-chave de cada cenário (chamada,
  transferências, filas, espera, ações do painel, escuta); toda gravação termina sem sobras;
  aplicar cada evento duas vezes dá o mesmo estado; nenhum delta repetido.
- `test/state/replay-consistency.test.ts`: um navegador que recebe o snapshot em **qualquer**
  ponto e depois só os deltas (um a um ou compactados em lotes, como o `ServerFeed` envia)
  chega exatamente ao estado do servidor.
- `test/state/visibility.test.ts`: o mesmo para navegadores com escopo de empresa.

## Carga (manual)

```bash
npm run load-test                       # cenário padrão (~1 min)
npm run load-test -- --endpoints 2000 --calls 1000 --clients 100 --scoped 50 --duration 120
npm run load-test -- --out relatorio.json
```

Nada externo é usado: um **PBX simulado** (worker thread) fala AMI com os mesmos eventos das
gravações reais e responde às listas com o estado vivo; **navegadores simulados** (outra
worker thread) autenticam, recebem snapshot + deltas e medem a latência. O backend real
(conexão AMI → sincronização → estado → feed → WebSocket) roda na thread principal, e a
**ocupação do event loop (ELU)** medida é só a dele.

O teste mede: eventos AMI/s, ELU do backend, memória, latência PBX → navegador (inclui a
janela de lote de 50 ms), mensagens e bytes por navegador, ressincronizações, conexões perdidas
e, no fim, se a cópia do estado montada por um navegador é **idêntica** ao estado do servidor.

Opções: `--endpoints`, `--queues`, `--members`, `--calls` (simultâneas), `--talk` (duração
média, s), `--queue-ratio`, `--clients` (sem escopo), `--scoped` (com escopo de empresa: 10% dos
ramais e 1 fila cada), `--duration`, `--out`.

## Resultados (2026-10-17)

Máquina de desenvolvimento (Windows 11, 12 threads, Node 22). O servidor real terá números
diferentes, mas a proporção entre os cenários vale.

| Cenário                                                         | Eventos/s | ELU backend | RSS    | Latência p50 / p95 / p99 | Consistência |
| --------------------------------------------------------------- | --------- | ----------- | ------ | ------------------------ | ------------ |
| 500 ramais, ~160 chamadas, 20 navegadores + 10 com escopo       | ~93       | 3%          | 159 MB | 62 / 64 / 65 ms          | OK           |
| 2000 ramais, ~830 chamadas, 150 navegadores sem escopo          | ~460      | 8%          | 241 MB | 67 / 74 / 78 ms          | OK           |
| 2000 ramais, ~830 chamadas, 100 navegadores + **50 com escopo** | ~478      | **43%**     | 270 MB | 64 / 111 / 120 ms        | OK           |

Nenhuma ressincronização nem conexão perdida em nenhum cenário. Com escopo, a latência medida
foi p50 75 ms / p99 154 ms no cenário pesado.

**Leitura:**

- O caminho AMI → estado → navegadores é barato: ~460 eventos/s e 150 navegadores com 8% do
  event loop.
- O custo dominante é o **recorte por empresa** (`ScopedView`): a cada lote (até 20/s), cada
  navegador com escopo recalcula a visibilidade percorrendo todas as chamadas do PBX. No cenário
  pesado, cada navegador com escopo custa ~0,7% do event loop.
- Para os clientes atuais (dezenas de ramais) há folga de sobra. Para um PBX multi-empresa
  grande, a otimização está registrada no roadmap (item 25, "Recorte por escopo incremental").

**Otimização aplicada:** o lote compartilhado pelos navegadores sem escopo é serializado uma vez
só (antes, uma vez por navegador): ELU 46% → 43% no cenário pesado.

## Histórico de revisões

| Data       | Autor       | O que mudou                             |
| ---------- | ----------- | --------------------------------------- |
| 2026-10-17 | Claude Code | Versão inicial (replay, carga, medidas) |
