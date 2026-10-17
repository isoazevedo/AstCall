# AstCall — Roadmap de Implementação

> Documento criado em: 2026-10-16
> Módulo: `/` (projeto completo: `apps/realtime/`, `apps/web/`, `packages/shared/`, `docs/`)
> Responsável: Israel Azevedo
> Última revisão: 2026-10-17

---

## Resumo executivo

O AstCall é um painel de monitoramento em tempo real para **Asterisk 22**, inspirado no MonAst e reimplementado com stack moderna: backend **Node.js + TypeScript** com conexão persistente ao **AMI**, estado em memória e envio de **snapshot + deltas via WebSocket**; frontend **Vue 3** compilado como **Web Component**. É um único produto com **dois modos de implantação**: **standalone** (login e usuários próprios) e **integrado** como módulo do **AzCall** (sistema PHP existente, que emite o JWT e liga/desliga o módulo). Relatórios de CDR e filas ficam a cargo do AzCall e estão fora deste roadmap.

---

## Já implementado

| #   | Funcionalidade                          | Descrição resumida                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Status         |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | **Diretrizes do projeto**               | `CLAUDE.md` com stack, requisitos, diretrizes do Asterisk 22 e os dois modos de implantação.                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅ Produção    |
| 2   | **Análise do MonAst**                   | Leitura de `reference/monast/` (eventos, modelo de estado, ações, permissões) e plano de arquitetura adaptado ao Asterisk 22.                                                                                                                                                                                                                                                                                                                                                                                                | ✅ Produção    |
| 3   | **Decisões de stack**                   | TypeScript, Vue 3 + Vite + Pinia, Web Component, JWT RS256 com `AUTH_MODE` (`local`/`external`/`both`).                                                                                                                                                                                                                                                                                                                                                                                                                      | ✅ Produção    |
| 4   | **Roadmap**                             | Este documento, seguindo `docs/ROADMAP_MODELO.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅ Produção    |
| 5   | **Monorepo (item 1)**                   | npm workspaces, TypeScript, ESLint/Prettier, Vitest, configuração validada com zod, `@astcall/shared` e casca da SPA Vue.                                                                                                                                                                                                                                                                                                                                                                                                    | ✅ Produção    |
| 6   | **Cliente AMI (item 2)**                | Parser incremental, correlação por `ActionID`, listas (`EventList`), timeouts, bloqueio de CR/LF, reconexão com backoff, Ping e gravador de tráfego (`AMI_RECORD_DIR`). Validado no laboratório (Asterisk 20.9.2).                                                                                                                                                                                                                                                                                                           | ✅ Produção    |
| 7   | **Estado em memória (item 3)**          | `ServerStore` com endpoints, canais, bridges e chamadas por `Linkedid`, links atravessando canais Local, deltas sem repetição. Testado com 6 cenários gravados no laboratório.                                                                                                                                                                                                                                                                                                                                               | 🔄 Homologação |
| 8   | **Sincronização (item 4)**              | `Synchronizer`: estado zerado e reconstruído pelas listas do AMI a cada conexão, itens aplicados na ordem do stream (sem buffer), listas vazias com `Error` toleradas, ressincronização com debounce após `Reload`. Validado no laboratório (24 endpoints em ~230 ms).                                                                                                                                                                                                                                                       | 🔄 Homologação |
| 9   | **Autenticação standalone (item 6)**    | JWT RS256 (`jose`), usuários em SQLite (`node:sqlite`) com bcrypt, `/auth/login`, `/auth/refresh` (cookie HttpOnly com rotação) e `/auth/logout`, limite de tentativas, `TokenVerifier` multi-emissor, CLI `npm run user` e `npm run keys:generate`.                                                                                                                                                                                                                                                                         | 🔄 Homologação |
| 10  | **Hub WebSocket (item 5)**              | `/monitor-ws` com `ws`: autenticação na 1ª mensagem, renovação e expiração do token, assinatura por servidor com permissão `view`, snapshot + deltas em lotes de 50 ms numerados (`epoch`/`seq`), `resync`, ping e proteção contra cliente lento. Testado ponta a ponta com o laboratório.                                                                                                                                                                                                                                   | 🔄 Homologação |
| 11  | **Primeiro painel (item 7)**            | Web Component `<ast-monitor>` (Vue 3 + Pinia, Shadow DOM) com tema Frest do AzCall herdado via `--bs-*`, ramais com filtros, chamadas com participantes e duração ao vivo; SPA standalone com login; build em modo biblioteca (`dist/element/ast-monitor.js`, ~43 kB gzip). Validado com o laboratório.                                                                                                                                                                                                                      | 🔄 Homologação |
| 12  | **Documentação do AMI (item 8)**        | `docs/manager.conf.md`: usuário `astcall` com `read=system,call,agent`, `write` sem `command`, restrição por IP, `eventfilter` (corta 74% dos eventos na gravação do laboratório), riscos e roteiro de validação. Validado no laboratório com o usuário `astcall`.                                                                                                                                                                                                                                                           | ✅ Produção    |
| 13  | **Filas (item 9)**                      | Filas, membros (situação, pausa com motivo e início) e chamadores aguardando; status de chamada "Na fila" e "via fila X"; `QueueStatus` na sincronização (opcional) e reconciliação a cada 60 s; aba "Filas" no painel com alertas de espera (60/180 s). Testado com 4 gravações reais (atendida, abandono, dois membros, pausa).                                                                                                                                                                                            | 🔄 Homologação |
| 14  | **Ações (item 12 + pausa do item 13)**  | `ActionService` com lista fechada (pausar/retomar membro, desligar, transferir cega, ligar), permissão por servidor, limite por usuário, contexto do ramal descoberto no Asterisk (tenant do AzCall) e auditoria; botões no painel conforme permissões. Validado no laboratório com telefones: pausar/retomar, ligar 9001→9002, transferir 9002→9005, desligar.                                                                                                                                                              | 🔄 Homologação |
| 15  | **Escuta (item 14)**                    | Botão Escutar com modos Ouvir/Sussurrar/Intervir (ChanSpy `qE`/`qEw`/`qEB`); o diálogo sempre pede o ramal que vai tocar (ex.: ramal de um diretor), sugerindo o último usado; "Em escuta" na chamada e "9005 escutando 9002" na linha do supervisor. Os três modos validados com telefones no laboratório. Gravação manual fora de escopo (o AzCall já grava todas as chamadas).                                                                                                                                            | 🔄 Homologação |
| 16  | **Integração AzCall (item 16)**         | Token RS256 emitido pelo AzCall (`AstCallTokenService`) com permissões `astcall.*` e escopo multi-empresa; snapshot/deltas/ações recortados por empresa; página `/astcall`, módulo liga/desliga em /config, menu; AstCall no servidor do laboratório (PM2 + proxy Apache em `/astcall/`). Teste de contrato OK (admin vê 12 endpoints/3 filas; super_admin vê 24/5). Validado no navegador: super_admin vê tudo; admin da empresa Avoip vê só o ramal 7100 (exatamente o cadastro). Contrato em `docs/INTEGRACAO_AZCALL.md`. | ✅ Produção    |
| 17  | **Modo TV (item 24)**                   | `<ast-monitor mode="tv">`: wallboard escuro, só leitura, letras grandes; telas Filas (aguardando, maior espera ao vivo, atendidas, abandono, NS, agentes) e Chamadas (chamadas em curso + mapa de ramais); rodízio a cada 15 s (atributo `rotate`) que o usuário liga/desliga na própria tela, com a escolha salva no navegador; tela cheia. AzCall: `/astcall/tv` e botão "Modo TV"; standalone: `/?tv`.                                                                                                                    | ✅ Produção    |
| 18  | **Membros de fila (item 13)**           | Adicionar membro dinâmico, remover (só dinâmico) e alterar penalidade pelo painel, com a permissão nova `queue_manage` e escopo por empresa; membros fixos (cadastro do AzCall) identificados na tela. Ações em menu "⋮" (também nas chamadas). Validado no laboratório. Conferências fora (item 10 pausado).                                                                                                                                                                                                                | ✅ Produção    |
| 19  | **Reconciliação e auditoria (item 15)** | Canais e bridges reconciliados a cada 60 s (fantasmas removidos, perdidos criados, sem sobrescrever o que existe); auditoria das ações em arquivo JSON por linha com `npm run audit` e logrotate.                                                                                                                                                                                                                                                                                                                            | 🔄 Homologação |

---

## Backlog de melhorias

As oportunidades abaixo foram identificadas e priorizadas por impacto vs. esforço de implementação. A ordem numérica corresponde à ordem sugerida de execução. A meta da alta prioridade é o **modo standalone somente leitura** funcionando de ponta a ponta.

---

### ALTA PRIORIDADE

---

#### 1. Estrutura do monorepo, configuração e tipos compartilhados — ✅

**O que é:** Criar a estrutura base do projeto (npm workspaces), ferramentas de build, lint e testes, carregamento de configuração por variáveis de ambiente e o pacote de tipos compartilhados.

**Por que fazer:** É a fundação para todos os demais itens; garante desde o início que credenciais nunca sejam versionadas e que o design já considere múltiplos servidores.

**Como implementar:**

1. Criar `apps/realtime` (Node.js), `apps/web` (Vue) e `packages/shared` (tipos e contratos).
2. Configurar TypeScript (`tsconfig.base.json`), ESLint + Prettier e Vitest no workspace.
3. Criar `.env.example` (credenciais AMI por servidor, porta HTTP/WS, `AUTH_MODE`, caminhos das chaves JWT) e `config/servers.example.json` (lista de servidores sem segredos).
4. Validar a configuração na inicialização com zod e falhar com mensagem clara em pt-BR.
5. Criar `.gitignore` (`.env`, `node_modules`, `dist`, chaves, banco SQLite, `reference/`).

**Arquivos envolvidos:**

- `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc` — workspace e configuração comum
- `apps/realtime/src/config/` — carregamento e validação de configuração
- `packages/shared/src/` — tipos iniciais (servidor, entidades, mensagens WS)
- `.env.example`, `config/servers.example.json`, `.gitignore`

**Esforço estimado:** P
**Impacto esperado:** Alto
**Dependências:** Nenhuma

---

#### 2. Cliente AMI com reconexão automática — ✅

**O que é:** Cliente AMI próprio e enxuto: conexão TCP, parser do protocolo, correlação de respostas por `ActionID`, coleta de listas (`EventList: start/Complete`) e reconexão com backoff.

**Por que fazer:** É a base de todo o monitoramento. Um cliente próprio dá controle fino sobre listas, buffer de eventos durante a sincronização e ciclo de vida da conexão — pontos que bibliotecas prontas costumam tratar mal.

**Como implementar:**

1. `AmiClient`: socket, parser de pacotes (`\r\n\r\n`), `sendAction()` retornando Promise, `sendListAction()` que agrega os eventos até o `...Complete`.
2. `AmiConnection`: login, estados (`connecting`, `syncing`, `ready`, `disconnected`), backoff exponencial (1s → 30s), keepalive com `Ping`.
3. Timeout por action e rejeição de pendências quando a conexão cai.
4. Testes unitários do parser com capturas reais de tráfego AMI.

**Arquivos envolvidos:**

- `apps/realtime/src/ami/AmiClient.ts` — protocolo e correlação
- `apps/realtime/src/ami/AmiConnection.ts` — ciclo de vida e reconexão
- `apps/realtime/test/ami/` — testes do parser

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Item 1

---

#### 3. Store de estado e handlers de eventos (ramais, canais, bridges, chamadas) — 🔄

**O que é:** Estado em memória por servidor e handlers que transformam eventos AMI em mutações, gerando deltas.

**Por que fazer:** Corrige o principal problema do MonAst: bridges tratadas como pares. No Asterisk 22, bridges têm N canais e chamadas devem ser correlacionadas por `Linkedid`/`Uniqueid`, inclusive em transferências e filas.

**Como implementar:**

1. `ServerStore` com `Map`s por domínio e emissão de deltas (`upsert`/`remove`) a cada mutação.
2. Endpoints PJSIP: `deviceState`, contatos (`ContactStatus`), contador de canais ativos.
3. Canais (chave `Uniqueid`): `Newchannel`, `Newstate`, `NewCallerid`, `NewConnectedLine`, `Rename`, `Hold`/`Unhold`, `Hangup`.
4. Bridges (chave `BridgeUniqueid`): `BridgeCreate`/`Enter`/`Leave`/`Destroy`; discagem: `DialBegin`/`DialEnd`.
5. Chamadas derivadas, agrupadas por `Linkedid`.
6. Handlers idempotentes (aplicar o mesmo evento duas vezes não corrompe o estado).

**Arquivos envolvidos:**

- `apps/realtime/src/state/ServerStore.ts` — store e emissor de deltas
- `apps/realtime/src/state/domains/` — endpoints, channels, bridges, calls
- `apps/realtime/src/handlers/` — um arquivo por domínio
- `packages/shared/src/entities.ts` — tipos das entidades

**Esforço estimado:** G
**Impacto esperado:** Alto
**Dependências:** Item 2

---

#### 4. Sincronização inicial e ressincronização completa — 🔄

**O que é:** Ao conectar ou reconectar no AMI, reconstruir o estado completo do PBX sem perder eventos que chegam durante o processo.

**Por que fazer:** Requisito obrigatório do projeto. Evita o comportamento do MonAst de forçar recarga do navegador e garante consistência após quedas.

**Como implementar:**

1. Entrar em `syncing`. ~~Guardar eventos em buffer~~ → os itens das listas são aplicados na ordem em que chegam, intercalados com os eventos ao vivo (mesma ordem do stream TCP), o que evita sobrescrever dados novos com antigos.
2. Limpar o store e executar: `PJSIPShowEndpoints`, `PJSIPShowContacts`, `DeviceStateList`, `BridgeList`, `CoreShowChannels`. `QueueStatus`/`QueueSummary`, `ConfbridgeListRooms`/`ConfbridgeList` e `ParkedCalls` entram em `SYNC_LISTS` junto com os itens 9 a 11.
3. Incrementar o `epoch` e emitir `synced` (o hub do item 5 envia o snapshot aos clientes).
4. Ressincronizar após `Reload` de módulos relevantes, **com debounce** (3 s). O AzCall faz reload com `Module: All` a cada alteração de configuração, então o filtro por módulo pouco ajuda nesse caso; o debounce agrupa reloads seguidos. `FullyBooted` não dispara ressincronização: após um restart do Asterisk a conexão cai e a reconexão já sincroniza.
5. Tratar como lista vazia as actions que respondem `Response: Error` sem itens (ex.: `ConfbridgeListRooms` → "No active conferences.").

**Arquivos envolvidos:**

- `apps/realtime/src/sync/Synchronizer.ts` — orquestração da sincronização e do reload
- `apps/realtime/src/ami/AmiClient.ts` — itens de lista entregues na ordem do stream (`onItem`)

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Itens 2 e 3

---

#### 5. Hub WebSocket (snapshot + deltas) — 🔄

**O que é:** Servidor WebSocket que entrega snapshot inicial e atualizações incrementais por servidor Asterisk.

**Por que fazer:** Substitui o polling HTTP do MonAst (`getUpdates`), reduzindo latência e carga.

**Como implementar:**

1. Mensagens `auth`, `subscribe`, `snapshot`, `delta`, `server_status` e `action_result`, tipadas em `packages/shared`.
2. A primeira mensagem do cliente deve ser `{ t: "auth", token }`; sem autenticação válida em poucos segundos, a conexão é fechada.
3. `seq` por servidor e `epoch` por sincronização; cliente pede novo snapshot ao detectar lacuna.
4. Agrupar deltas em janelas de 50–100 ms.
5. Inscrição por servidor, respeitando os servidores presentes em `perms` do token.
6. Cronômetros calculados no cliente a partir de timestamps (`createdAt`).

**Arquivos envolvidos:**

- `apps/realtime/src/ws/Hub.ts` — conexões, autenticação, inscrições
- `apps/realtime/src/ws/ServerFeed.ts` — lotes, numeração, snapshots e status por servidor
- `packages/shared/src/protocol.ts` — tipos das mensagens

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Itens 3 e 6 (validação do token)

---

#### 6. Autenticação do modo standalone (`AUTH_MODE=local`) — 🔄

**O que é:** Usuários próprios do AstCall, login HTTP e emissão/validação de JWT RS256 com permissões por servidor.

**Por que fazer:** Permite usar o AstCall sem o AzCall (como o MonAst) e já estabelece o contrato de token que o AzCall seguirá no modo integrado.

**Como implementar:**

1. Camada `TokenVerifier` que valida RS256 contra as chaves públicas dos emissores configurados (`iss`).
2. Usuários em SQLite (`node:sqlite`, nativo do Node 22) com senha bcrypt (`bcryptjs`) e permissões por servidor (curinga `*`); CLI `npm run user -- add|list|passwd|perms|disable|enable|remove`.
3. `POST /auth/login` (token curto + cookie de renovação `HttpOnly`/`SameSite=Strict` em `/auth`), `POST /auth/refresh` (rotação do cookie; é o `token-url` do modo standalone) e `POST /auth/logout`. Limite de 10 falhas por IP/usuário em 15 min; usuário inexistente gasta o mesmo tempo que senha errada.
4. Documentar as claims (`sub`, `name`, `iss`, `exp`, `perms`) em `packages/shared` e em `docs/`.

**Arquivos envolvidos:**

- `apps/realtime/src/auth/` — `TokenVerifier`, `LocalIssuer`, `UserRepository`, rotas HTTP
- `apps/realtime/scripts/users.ts` e `keys-generate.ts` — CLI de usuários e chaves
- `apps/realtime/src/http/server.ts` — servidor HTTP mínimo (o WebSocket usará o mesmo)
- `packages/shared/src/auth.ts` — tipos das claims

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Item 1

---

#### 7. Frontend: Web Component `<ast-monitor>` e SPA standalone (somente leitura) — 🔄

**O que é:** Primeira versão do painel, exibindo ramais PJSIP e chamadas em curso, empacotada como Web Component e servida também por uma SPA com tela de login.

**Por que fazer:** Entrega o primeiro valor visível do projeto, valida ponta a ponta o fluxo AMI → store → WS → navegador e já nasce no formato que o AzCall vai consumir.

**Como implementar:**

1. `<ast-monitor>` via `defineCustomElement` (Shadow DOM, Pinia via `configureApp`, componentes `*.ce.vue`), com atributos `ws-url` e `token-url`.
2. Store Pinia que aplica snapshot e deltas, com detecção de lacuna de `seq` e renovação do token.
3. Painel de ramais (estado do dispositivo, contatos) e painel de chamadas (agrupadas por `Linkedid`, com duração).
4. Indicador de conexão (`syncing`, `ready`, `disconnected` → painel marcado como desatualizado).
5. SPA standalone: tela de login → monta o mesmo componente. Tema por variáveis CSS.

**Arquivos envolvidos:**

- `apps/web/src/element/` — definição do custom element
- `apps/web/src/standalone/` — SPA com login
- `apps/web/src/stores/`, `apps/web/src/components/`, `apps/web/src/ws/`

**Esforço estimado:** G
**Impacto esperado:** Alto
**Dependências:** Itens 5 e 6

---

#### 8. Documentação do `manager.conf` (usuário mínimo e `eventfilter`) — ✅

**O que é:** Documento com a configuração recomendada do usuário AMI: permissões mínimas, restrição por IP e filtros de eventos.

**Por que fazer:** Requisito do projeto; reduz volume de eventos e superfície de ataque.

**Como implementar:**

1. Definir `read`/`write` mínimos, validando o privilégio de cada action com `manager show command <Action>` no Asterisk 22. Não conceder `command`.
2. Restringir com `deny`/`permit` ao IP do backend.
3. Listar os `eventfilter` de inclusão para os eventos usados, conferindo a sintaxe na documentação oficial do Asterisk 22.
4. Verificar se os filtros afetam eventos de resposta de listas (`EndpointList`, `CoreShowChannel` etc.).

**Arquivos envolvidos:**

- `docs/manager.conf.md` — documentação e exemplo comentado

**Esforço estimado:** P
**Impacto esperado:** Médio
**Dependências:** Itens 3 e 4 (lista final de eventos e actions)

---

### MÉDIA PRIORIDADE

---

#### 9. Filas — 🔄

**O que é:** Monitorar filas: parâmetros e estatísticas, membros e chamadas em espera.

**Por que fazer:** Funcionalidade central de operação de call center prevista no escopo.

**Como implementar:**

1. Domínios `queues`, `members` (chave `fila + interface`) e `entries` (chave `fila + uniqueid`).
2. Eventos `QueueMemberAdded`/`Removed`/`Status`/`Pause`, `QueueCallerJoin`/`Leave`/`Abandon`.
3. Identificar quem atendeu via `AgentConnect`/`AgentComplete` (sem a heurística de "chamada pendente" do MonAst).
4. Estatísticas (médias, totais) só vêm no `QueueStatus`: contadores ao vivo pelos eventos + reconciliação periódica (60 s), que também remove membros/chamadores que sumiram sem evento.
5. Pendente: gravação real com dois chamadores simultâneos na mesma fila (renumeração de posição coberta por teste sintético).
6. Painel de filas no frontend.

**Arquivos envolvidos:**

- `apps/realtime/src/state/domains/queues.ts`, `apps/realtime/src/handlers/queues.ts`
- `apps/web/src/components/queues/`

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Itens 3, 4 e 5

---

#### 10. Conferências ConfBridge — ⏸️

> **Pausado (2026-10-16):** no AzCall as conferências são operadas por discagem; o painel não precisa delas por ora.

**O que é:** Monitorar salas ConfBridge e participantes (admin, mudo, falando), com estado de bloqueio e gravação.

**Por que fazer:** Substitui o MeetMe (removido) de forma nativa, sem o `usernum` artificial do MonAst.

**Como implementar:**

1. Domínio `conferences` com participantes por `Uniqueid`.
2. Eventos `ConfbridgeStart`/`End`/`Join`/`Leave`/`Mute`/`Unmute`/`Talking`/`Lock`/`Unlock`/`Record`/`StopRecord`.
3. Painel de conferências no frontend.

**Arquivos envolvidos:**

- `apps/realtime/src/state/domains/conferences.ts`, `apps/realtime/src/handlers/confbridge.ts`
- `apps/web/src/components/conferences/`

**Esforço estimado:** M
**Impacto esperado:** Médio
**Dependências:** Itens 3, 4 e 5

---

#### 11. Chamadas estacionadas (parking) — ⏸️

> **Pausado (2026-10-16):** no AzCall o estacionamento é feito por discagem; o painel não precisa dele por ora.

**O que é:** Exibir chamadas estacionadas por lote e vaga, com tempo restante.

**Por que fazer:** Faz parte do escopo de monitoramento e habilita a ação de estacionar/retomar.

**Como implementar:**

1. Domínio `parked` com chave `ParkeeUniqueid`.
2. Eventos `ParkedCall`, `UnParkedCall`, `ParkedCallTimeOut`, `ParkedCallGiveUp`, `ParkedCallSwap`.
3. Painel de estacionamento no frontend.

**Arquivos envolvidos:**

- `apps/realtime/src/state/domains/parking.ts`, `apps/realtime/src/handlers/parking.ts`
- `apps/web/src/components/parking/`

**Esforço estimado:** P
**Impacto esperado:** Médio
**Dependências:** Itens 3, 4 e 5

---

#### 12. Ações de chamada — 🔄

**O que é:** Originar, desligar, transferir (cega e assistida) e estacionar chamadas pelo painel.

**Por que fazer:** Transforma o painel de passivo em ferramenta de operação.

**Como implementar:**

1. `ActionService`: validação do payload (zod) → permissão do token para o servidor → envio ao AMI → `action_result` ao cliente.
2. Mapear: `Originate` (Async), `Hangup`, `BlindTransfer` (pelo outro lado da bridge). `Atxfer` e `Park` ficam para depois (estacionamento é feito por discagem no AzCall).
3. Contexto de discagem descoberto por `PJSIPShowEndpoint` (o AzCall usa contexto por tenant); `CallerID` do originate = ramal de origem (com o destino, o destino via o próprio número — corrigido no teste de laboratório).
4. Menus de contexto e arrastar-e-soltar no frontend.

**Arquivos envolvidos:**

- `apps/realtime/src/actions/ActionService.ts`, `apps/realtime/src/actions/definitions/`
- `apps/web/src/components/` — menus e interações

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Itens 5, 6 e 7

---

#### 13. Ações de filas e conferências — ✅ (filas)

**O que é:** Adicionar, remover, pausar membros e alterar penalidade; expulsar, silenciar e bloquear em conferências.

**Por que fazer:** Ações operacionais previstas no escopo; substituem os comandos de CLI usados pelo MonAst.

**Decisões (2026-10-17):**

- O cadastro permanente de membros é do AzCall (`queue_members` → `member =>` no `queues.conf`, membros **fixos**). O painel faz mudanças operacionais: adiciona membros **dinâmicos** (`QueueAdd`), que continuam na fila após reload/reinício (`persistentmembers=yes`) até serem removidos, mas não entram no cadastro.
- `QueueRemove` só vale para membros dinâmicos (o Asterisk recusa remover fixo); para fixos o painel orienta a usar o cadastro ou a pausa.
- `QueuePenalty` vale para qualquer membro; nos fixos volta ao valor do cadastro no próximo reload das filas (o painel avisa).
- Permissão nova **`queue_manage`** (AzCall: `astcall.queue_manage`, migration 162), separada de `queue` (pausar/retomar).
- Conferências fora (item 10 pausado).

**Escopo:**

- [x] Filas: `QueueAdd` (interface sempre `PJSIP/<ramal>` montada no backend), `QueueRemove` (só dinâmico), `QueuePenalty`, `QueuePause` (item 12)
- [x] Escopo multi-empresa: ramal e fila precisam ser da empresa
- [x] Painel: botão "Adicionar" no card da fila (lista só ramais visíveis fora da fila, penalidade, entrar pausado), marca "dinâmico", botão de penalidade e de remover (só dinâmico)
- [x] Token tolerante a permissões desconhecidas (AzCall pode ser atualizado antes do AstCall)
- [x] Validado no laboratório: 9005 adicionado à suporte-default (dinâmico, persistido no astdb), removido e adicionado de novo
- [x] Ações num menu "⋮" (`ActionMenu`, dropdown/dropup) no membro de fila e em cada participante das chamadas
- [ ] ~~Conferências~~ (item 10 pausado)

**Arquivos envolvidos:**

- `apps/realtime/src/actions/ActionService.ts`, `packages/shared/src/actions.ts`, `packages/shared/src/auth.ts`
- `apps/web/src/components/QueueCard.ce.vue`, `apps/web/src/components/ActionDialog.ce.vue`
- AzCall: `AstCallTokenService::PERMISSION_MAP`, `database/migrations/162_seed_astcall_queue_manage.php`

**Esforço estimado:** P
**Impacto esperado:** Médio
**Dependências:** Itens 9, 10 e 12

---

#### 14. Escuta (ChanSpy) e gravação (MixMonitor) — 🔄

**O que é:** Escutar, sussurrar ou intervir em chamadas e iniciar/parar gravação.

**Por que fazer:** Funções de supervisão previstas no escopo. `Monitor` foi removido no Asterisk 21; deve-se usar `MixMonitor`.

**Como implementar:**

1. Escuta: `Originate` para o ramal do supervisor com aplicação `ChanSpy` e modos `q`, `w` (sussurro) e `B` (intervenção).
2. ~~Gravação: `MixMonitor` / `StopMixMonitor`~~ — fora de escopo por decisão (2026-10-16): o AzCall grava todas as chamadas automaticamente; o painel mostra o indicador REC. Retomar se houver servidores sem gravação automática.
   O ramal de quem escuta é sempre informado no diálogo (pode ser o de outra pessoa, ex.: um diretor), com o último usado como sugestão.
3. Refletir `ChanSpyStart`/`Stop` e `MixMonitorStart`/`Stop` no estado do canal.

**Arquivos envolvidos:**

- `apps/realtime/src/actions/definitions/spy.ts`, `apps/realtime/src/actions/definitions/record.ts`
- `apps/realtime/src/handlers/channels.ts` — flags de escuta/gravação

**Esforço estimado:** P
**Impacto esperado:** Médio
**Dependências:** Item 12

---

#### 15. Reconciliação periódica e auditoria — 🔄

**O que é:** Verificação periódica leve do estado e registro de todas as ações executadas.

**Por que fazer:** Remove canais "fantasmas" causados por eventos perdidos (ideia do `taskCheckStatus` do MonAst) e dá rastreabilidade de quem fez o quê.

**Escopo:**

- [x] Reconciliação de canais e bridges a cada 60 s (`CHANNEL_RECONCILE_MS`): `BridgeList` + `CoreShowChannels`; remove fantasmas (ex.: `Hangup` perdido), cria o que falta, não sobrescreve canais existentes (o horário de atendimento dos eventos é exato) e preserva o que mudou por evento durante a consulta; aviso no log com as contagens
- [x] Reconciliação das filas (item 9) agora configurável (`QUEUE_REFRESH_MS`)
- [x] Auditoria em arquivo (`AUDIT_FILE`, JSON por linha): usuário, nome, emissor, servidor, ação, parâmetros, actions AMI, resultado; `npm run audit` para consultar; rotação com logrotate (`docs/AUDITORIA.md`)
- [ ] Auditoria no log de atividades do AzCall — adiado (decisão de 2026-10-17: só arquivo por enquanto)
- [ ] Ativar no laboratório e observar

**Arquivos envolvidos:**

- `apps/realtime/src/sync/Synchronizer.ts`, `apps/realtime/src/audit/AuditLog.ts`, `apps/realtime/scripts/audit.ts`

**Esforço estimado:** P
**Impacto esperado:** Médio
**Dependências:** Itens 4 e 12

---

#### 16. Integração com o AzCall (modo integrado) — ✅

**O que é:** Permitir que o AzCall embuta o painel, emita o JWT e habilite/desabilite o módulo.

**Atenção — AzCall é multi-empresa:** usuários são vinculados a `company_id` e filas/contextos usam sufixo de tenant (ex.: `marcacao-default`, `from-internal-default`). Permissão por servidor não basta: o token precisa carregar o escopo da empresa e o backend deve filtrar endpoints, chamadas e filas por tenant. Também a classificação ramal × tronco vem do banco do AzCall (tabelas `extensions`/`trunks`), não do AMI. E o AzCall já tem um monitoramento próprio (`ws-agent`): decidir se o AstCall o substitui.

**Por que fazer:** Leva o AstCall para dentro do AzCall sem segundo login, mantendo o mesmo código do modo standalone.

**Como implementar:**

1. `AUTH_MODE=external`/`both` no Node, com a chave pública do AzCall e o `iss` esperado.
2. Documentar o contrato em `docs/INTEGRACAO_AZCALL.md`: tag e atributos, URL do WS, claims do token, endpoint de renovação.
3. No AzCall: emissão do token RS256, endpoint `token-url`, flag de módulo (menu, página com a tag, endpoint de token), escopo de empresa no token e `--ast-card-bg` no modo escuro (o tema não expõe a cor do card na raiz).
4. Proxy no Nginx/Apache do AzCall (`/monitor-ws` com `Upgrade`/`Connection` e `proxy_read_timeout` alto) e publicação do bundle do Web Component.

**Arquivos envolvidos:**

- `apps/realtime/src/auth/tokens.ts` (`TokenVerifier`) — emissores externos
- `docs/INTEGRACAO_AZCALL.md` — contrato
- Código do AzCall (fora deste repositório)

**Esforço estimado:** M
**Impacto esperado:** Alto
**Dependências:** Itens 6 e 7

---

### BAIXA PRIORIDADE / NICE TO HAVE

---

#### 17. Gestão de usuários pela interface (modo standalone)

**O que é:** Telas para cadastrar usuários e permissões por servidor, substituindo o comando de linha.

**Por que fazer:** Facilita a operação do modo standalone sem acesso ao servidor.

**Esforço estimado:** M
**Impacto esperado:** Médio

---

#### 18. Widgets separados (`<ast-ramais>`, `<ast-filas>` etc.)

**O que é:** Expor painéis individuais como Web Components próprios, reaproveitando a mesma conexão.

**Por que fazer:** Permite ao AzCall montar telas sob medida (ex.: só filas em um dashboard).

**Esforço estimado:** M
**Impacto esperado:** Médio

---

#### 19. Múltiplos servidores Asterisk em produção

**O que é:** Ativar de fato várias conexões AMI simultâneas, com seletor de servidor no frontend.

**Por que fazer:** O design já prevê `serverId` em todas as entidades e mensagens; este item valida e expõe a funcionalidade.

**Esforço estimado:** M
**Impacto esperado:** Médio

---

#### 20. Escala horizontal com Redis

**O que é:** Separar coletores AMI (um por PBX) de gateways WebSocket, sincronizados por Redis pub/sub.

**Por que fazer:** Necessário apenas com muitos usuários simultâneos ou alta disponibilidade.

**Esforço estimado:** G
**Impacto esperado:** Baixo

---

#### 21. Testes de replay e carga

**O que é:** Gravar sessões reais de eventos AMI e reproduzi-las contra o store para testes de regressão e desempenho.

**Por que fazer:** Garante que a correlação de chamadas (transferências, filas) não quebre com mudanças futuras.

**Esforço estimado:** M
**Impacto esperado:** Médio

---

#### 22. Controle avançado via ARI

**O que é:** Avaliar ARI para cenários de controle que o AMI não cobre bem, mantendo o AMI como base do monitoramento.

**Por que fazer:** Abre espaço para funcionalidades futuras sem alterar a arquitetura de monitoramento.

**Esforço estimado:** G
**Impacto esperado:** Baixo

---

#### 23. AMI sobre TLS

**O que é:** Suporte a `tlsenable` (porta 5039) no cliente AMI, com opção `tls` por servidor em `config/servers.json`.

**Por que fazer:** O AMI em TCP puro trafega usuário, senha e eventos sem criptografia. Necessário quando o backend não está no mesmo servidor/rede do Asterisk (hoje mitigado com rede interna/VPN e firewall).

**Esforço estimado:** P
**Impacto esperado:** Médio

---

#### 24. Modo TV (wallboard) — ✅

**O que é:** O mesmo `<ast-monitor>` com `mode="tv"`: tela escura e só leitura para deixar numa TV da operação, inspirada no "Modo TV" do SmartQueue do AzCall.

**Por que fazer:** Supervisores e equipes acompanham filas e chamadas de longe, sem operar o painel.

**Escopo:**

- [x] Tela **Filas**: um bloco por fila (aguardando, maior espera com cores 60/180 s, atendidas, abandonadas e %, espera média, nível de serviço, agentes livres/em atendimento/pausados/offline)
- [x] Tela **Chamadas**: chamadas em curso (até 10, depois "+N") com duração ao vivo, fila, gravação e escuta; mapa de ramais por cor
- [x] **Rodízio** entre as telas (padrão 15 s, atributo `rotate`, `0` começa desligado), ligado/desligado na própria tela; rodízio e tela escolhida salvos no `localStorage`
- [x] Sem filas no escopo: a tela Filas sai do rodízio
- [x] Tela cheia, relógio, totais, selo de conexão; controles somem com o mouse parado
- [x] AzCall: rota `/astcall/tv` (sem o layout, `?rotate=N`) e botão "Modo TV" em `/astcall`
- [x] Standalone: `/?tv` (e `&rotate=N`) e link "Modo TV" na barra
- [x] Validado no laboratório: chamada do 9005 na fila suporte-default (aguardando e maior espera ao vivo), atendida no 9001 (em conversa, atendidas +1)
- [ ] Confirmar numa TV ligada por mais de 2 h que a sessão do AzCall não expira (cookie renovado pelo `/astcall/token`)

**Esforço estimado:** P
**Impacto esperado:** Médio

---

## Critérios de priorização

| Critério                                        | Peso  |
| ----------------------------------------------- | ----- |
| Impacto direto no usuário final                 | Alto  |
| Redução de retrabalho / erros operacionais      | Alto  |
| Complexidade técnica de implementação           | Médio |
| Dependência de terceiros / integrações externas | Médio |
| Melhoria de performance ou escalabilidade       | Baixo |

---

## Legenda de status

| Ícone | Significado                                 |
| ----- | ------------------------------------------- |
| ✅    | Produção — estável                          |
| 🔄    | Homologação — aguardando validação          |
| 🚧    | Em andamento — desenvolvimento iniciado     |
| 📋    | Backlog — planejado, não iniciado           |
| ⏸️    | Pausado — aguardando decisão ou dependência |
| ❌    | Cancelado — descartado com justificativa    |

---

## Histórico de revisões

| Data       | Autor       | O que mudou                                                                                                                                                                                         |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | Claude Code | Criação do documento a partir da análise do MonAst e do `CLAUDE.md`                                                                                                                                 |
| 2026-10-16 | Claude Code | Decisões de stack fechadas; produto com modos standalone e integrado (AzCall); Web Component; autenticação `AUTH_MODE`; `apps/admin` removido (parte PHP é o AzCall); novos itens 6, 7, 16, 17 e 18 |
| 2026-10-16 | Claude Code | Item 1 implementado e em homologação                                                                                                                                                                |
| 2026-10-16 | Claude Code | Item 1 concluído; item 2 (cliente AMI) implementado e em homologação                                                                                                                                |
| 2026-10-16 | Claude Code | Item 2 validado no laboratório; item 3 implementado com fixtures reais (chamada, não atendida, transferências cega e assistida, fila, registro); refinado o item 4 (Reload seletivo)                |
| 2026-10-16 | Claude Code | Item 4 implementado (sincronização em ordem de stream, debounce de Reload) e validado no laboratório                                                                                                |
| 2026-10-16 | Claude Code | Item 6 implementado (autenticação standalone) e testado ponta a ponta                                                                                                                               |
| 2026-10-16 | Claude Code | Item 5 implementado (hub WebSocket) e testado ponta a ponta com o laboratório; backend pronto para o primeiro painel (item 7)                                                                       |
| 2026-10-16 | Claude Code | Item 7 implementado (painel Vue com tema Frest) e validado no navegador com o laboratório; item 16 recebe os requisitos de multi-empresa do AzCall                                                  |
| 2026-10-16 | Claude Code | Item 8 documentado (aguarda validação no laboratório); novo item 23 (AMI sobre TLS)                                                                                                                 |
| 2026-10-16 | Claude Code | Item 8 validado no laboratório (usuário `astcall`: listas OK, `Command` recusado, eventos de chamada passam pelo filtro)                                                                            |
| 2026-10-16 | Claude Code | Item 9 implementado (filas) com gravações reais do laboratório                                                                                                                                      |
| 2026-10-16 | Claude Code | Itens 10 e 11 pausados (operados por discagem no AzCall); próximo: item 12                                                                                                                          |
| 2026-10-16 | Claude Code | Item 12 implementado e validado com telefones no laboratório (inclui a pausa de fila do item 13)                                                                                                    |
| 2026-10-16 | Claude Code | Item 14 implementado (escuta) e validado com telefones: ouvir, sussurrar (só o ramal monitorado ouve) e intervir (os dois ouvem)                                                                    |
| 2026-10-17 | Claude Code | Item 16 implementado e instalado no laboratório (aguarda validação no navegador com usuários do AzCall)                                                                                             |
| 2026-10-17 | Claude Code | Item 16 validado no navegador (super_admin e admin de outra empresa); corrigido erro no menu do layout que derrubou o AzCall do laboratório após a implantação                                      |
| 2026-10-17 | Claude Code | Novo item 24 (modo TV, inspirado no SmartQueue) implementado; validado no navegador com o laboratório (rodízio, preferência salva); aguarda teste numa TV com chamadas                              |
| 2026-10-17 | Claude Code | Item 24 instalado e validado no laboratório com chamada na fila; falta só observar a sessão em uso prolongado                                                                                       |
| 2026-10-17 | Claude Code | Item 13 implementado (gestão de membros de fila, permissão `queue_manage`); aguarda validação no laboratório                                                                                        |
| 2026-10-17 | Claude Code | Item 13 (filas) validado no laboratório; ações de membro e de chamada passam para um menu "⋮"                                                                                                       |
| 2026-10-17 | Claude Code | `eventfilter` aplicado ao usuário `astcall` no laboratório (+`EndpointDetail`); listas da sincronização verificadas com o filtro ativo                                                              |
| 2026-10-17 | Claude Code | Item 15 implementado (reconciliação de canais/bridges e auditoria em arquivo)                                                                                                                       |
