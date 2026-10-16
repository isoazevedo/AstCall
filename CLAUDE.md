# CLAUDE.md

## Idioma

**Todas as respostas, explicações, comentários de código, mensagens de commit e documentação devem ser escritos em português do Brasil (pt-BR).** Nomes de variáveis, funções e classes podem seguir o padrão em inglês, mas toda comunicação com o usuário deve ser em pt-BR.

## Sobre o projeto

Painel de monitoramento em tempo real para **Asterisk 22**, inspirado no MonAst (Monitor for Asterisk). O objetivo é reimplementar a ideia do MonAst com stack moderna, e não traduzir o código original.

O painel deve exibir e permitir interagir com:

- Endpoints PJSIP (ramais/troncos) e seus estados
- Canais ativos e chamadas em curso
- Filas (membros, chamadas em espera, estatísticas)
- Conferências ConfBridge
- Chamadas estacionadas (parking)

Ações previstas: originar, desligar, transferir, escutar (spy/ChanSpy), gravar (MixMonitor), adicionar/remover/pausar membros de fila, ações de conferência.

## Um produto, dois modos de implantação

O AstCall é **um único produto** (um só código) que funciona de duas formas:

|                  | Modo **standalone**                                  | Modo **integrado** (módulo do AzCall)                        |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Quem autentica   | O próprio AstCall (tela de login, usuários próprios) | O **AzCall** (sistema PHP existente), sem segundo login      |
| Quem emite o JWT | Backend Node                                         | AzCall (PHP)                                                 |
| Interface        | SPA própria: login + painel                          | Página PHP do AzCall com a tag do Web Component              |
| Liga/desliga     | Serviço rodando ou não                               | Flag de módulo **no AzCall** (menu, tag e endpoint de token) |

- O **contrato entre os modos é o JWT**: os dois geram tokens com as mesmas claims. O restante do sistema não sabe quem emitiu o token.
- O AzCall depende apenas de três contratos estáveis: **tag + atributos do Web Component**, **URL do WebSocket** e **formato do token**. Mudanças nesses contratos devem ser documentadas e versionadas.
- Prioridade: núcleo + modo standalone primeiro (é também o ambiente de desenvolvimento); integração com o AzCall depois.

## Stack (decisões fechadas)

- **Linguagem:** **TypeScript** no backend e no frontend.
  - Monorepo com **npm workspaces**.
  - Tipos de eventos AMI, do estado do PBX e do protocolo WebSocket compartilhados em `packages/shared`.
- **Backend de tempo real:** Node.js (22 LTS) + TypeScript
  - Conexão persistente com o **AMI** do Asterisk (cliente AMI próprio e enxuto)
  - Estado do PBX mantido em memória (Redis opcional para escalar)
  - Comunicação com o navegador via **WebSocket** (sem polling)
- **Frontend:** **Vue 3 + Vite + TypeScript**, com **Pinia** para o estado
  - Consome snapshot inicial + atualizações incrementais (deltas) via WebSocket
  - O usuário está aprendendo Vue agora: preferir código idiomático e didático (Composition API com `<script setup>`), explicar em pt-BR os conceitos de Vue usados quando forem novos e evitar abstrações desnecessárias.
- **Parte administrativa do modo integrado:** PHP (sistema existente **AzCall**)
  - O PHP **não** mantém conexão com o AMI; isso é responsabilidade do backend Node.js.

## Estrutura do repositório

```
apps/realtime/   # backend Node.js (AMI, estado, WebSocket, ações, autenticação)
apps/web/        # frontend Vue: Web Component <ast-monitor> + SPA standalone (login + painel)
packages/shared/ # tipos e contratos compartilhados (protocolo WS, claims do JWT, entidades)
docs/            # roadmap, manager.conf, contratos de integração
reference/       # MonAst original — apenas referência, fora do git
```

## Frontend como Web Component

- O núcleo do painel é compilado como **Web Component** (`defineCustomElement` do Vue 3, build em modo biblioteca do Vite):
  ```html
  <ast-monitor ws-url="/monitor-ws" token-url="/azcall/monitor/token"></ast-monitor>
  ```
- Prefixo de tags neutro (`ast-`), pois o produto também vive sem o AzCall.
- Usar **Shadow DOM** para isolar o CSS; permitir personalização visual por **variáveis CSS** (cores, fontes).
- Projetar pensando em widgets reutilizáveis no futuro (ex.: `<ast-ramais>`, `<ast-filas>`).
- A SPA standalone (`npm run dev`) é uma casca fina: tela de login → monta o mesmo componente.
- Cuidados conhecidos com custom elements no Vue:
  - Instalar o Pinia pela opção `configureApp` do `defineCustomElement` (Vue 3.5+).
  - CSS de componentes filhos só entra no Shadow DOM se os arquivos forem `*.ce.vue` ou se o plugin do Vite estiver configurado para isso.
  - `@font-face` não funciona declarado apenas dentro do Shadow DOM; carregar fontes no documento.

## Autenticação e permissões

- **JWT RS256**: chave privada no emissor, chave pública no Node. O backend de tempo real **valida** tokens de qualquer emissor configurado.
- Configuração `AUTH_MODE` no Node:
  - `local` — usuários próprios (SQLite, senha com bcrypt); o Node emite o token.
  - `external` — o Node só valida tokens do AzCall.
  - `both` — aceita os dois (útil na transição).
- Claims mínimas: `sub`, `name`, `iss`, `exp` e **permissões por servidor**, ex.: `perms: { "pbx1": ["hangup", "spy"], "pbx2": ["queue"] }`.
- Validade **curta** (5–15 min). O componente renova o token via `token-url` antes de expirar e ao reconectar. Uma permissão removida só deixa de valer quando o token expira.
- **WebSocket:** o navegador não envia cabeçalho `Authorization` no handshake e token em query string vaza em logs. A **primeira mensagem** do cliente deve ser `{ "t": "auth", "token": "..." }`; sem autenticação válida em poucos segundos, o servidor fecha a conexão. Toda ação revalida a permissão no backend.
- **Mesmo domínio:** o Node fica atrás do mesmo Nginx/Apache do AzCall (ex.: `/monitor-ws` com proxy, cabeçalhos `Upgrade`/`Connection` e `proxy_read_timeout` alto), evitando CORS e problemas de certificado.

## Pasta de referência: `reference/monast/`

- Contém o código original do MonAst (Python + PHP) **apenas como referência**.
- **Não copiar nem portar literalmente** código dessa pasta.
- Use-a para entender: eventos do AMI escutados, modelo de estado, correlação de canais em chamadas, ações oferecidas e organização da interface.
- **Ignorar** tudo que for obsoleto para o Asterisk 22:
  - `chan_sip` (removido) → usar **PJSIP**
  - MeetMe (removido) → usar **ConfBridge**
  - `Monitor` (removido no Asterisk 21) → usar **MixMonitor**
  - Modelo de polling HTTP do frontend → usar **WebSocket**
  - Comandos de CLI livres (`CliCommand`) → **não** reimplementar
- Bridges no Asterisk 12+ têm N canais: modelar por `BridgeUniqueid`, não por pares de canais como o MonAst.
- Essa pasta está no `.gitignore` e não faz parte do projeto.

## Diretrizes técnicas do Asterisk 22

- **AMI** é a base do monitoramento (visão completa do PBX). ARI pode ser usado futuramente para controle avançado de chamadas, mas não substitui o AMI para monitoramento.
- **Sincronização inicial** ao conectar no AMI (com buffer dos eventos recebidos durante o processo):
  - `PJSIPShowEndpoints` / `PJSIPShowContacts` / `DeviceStateList`
  - `CoreShowChannels` / `BridgeList`
  - `QueueStatus` / `QueueSummary`
  - `ConfbridgeListRooms` / `ConfbridgeList`
  - `ParkedCalls`
- **Eventos principais:** `Newchannel`, `Newstate`, `Hangup`, `NewCallerid`, `NewConnectedLine`, `BridgeCreate`, `BridgeEnter`, `BridgeLeave`, `BridgeDestroy`, `DialBegin`, `DialEnd`, `DeviceStateChange`, `ContactStatus`, `QueueMemberStatus`, `QueueCallerJoin`, `QueueCallerLeave`, `AgentConnect`, `AgentComplete`, `ConfbridgeJoin`, `ConfbridgeLeave`, `ParkedCall`, `UnParkedCall`, `MixMonitorStart`, `MixMonitorStop`, `FullyBooted`, `Reload`.
- Correlacionar canais em chamadas usando `Linkedid` e `Uniqueid` (atenção a transferências e filas).
- Consultar sempre a documentação oficial do AMI do Asterisk 22 para actions e events; o MonAst serve só como mapa.

## Requisitos importantes

- **Reconexão automática** com o AMI, com **ressincronização completa** do estado após reconectar.
- Usar `eventfilter` no `manager.conf` (documentar os filtros necessários) para reduzir volume de eventos.
- Usuário AMI com **permissões mínimas** necessárias (sem `command`).
- **Nunca** expor o AMI diretamente ao navegador; todas as ações passam pelo backend, que valida permissões do usuário antes de enviar ao AMI.
- Suporte a **múltiplos servidores Asterisk** deve ser considerado no design (todo estado e toda mensagem carregam `serverId`).
- Credenciais e configurações sensíveis via variáveis de ambiente (`.env`), nunca versionadas.

## Forma de trabalhar

- Antes de implementar algo grande, apresentar um plano curto em pt-BR.
- Preferir código simples, modular e bem comentado (comentários em pt-BR).
- Manter `docs/ROADMAP.md` atualizado (status dos itens e histórico de revisões).
- Ao terminar uma tarefa, resumir em poucas linhas o que foi feito e o próximo passo sugerido.
