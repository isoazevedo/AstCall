# Configuração do AMI para o AstCall (`manager.conf`)

> Vale para **Asterisk 20 LTS e 22 LTS**. Testado no laboratório com Asterisk 20.9.2.
> Última revisão: 2026-10-16

O AstCall precisa de **um usuário AMI próprio**, com o mínimo de permissões, aceito só a partir
do IP do backend e recebendo só os eventos que usa. Este documento traz a configuração
recomendada, o porquê de cada linha e como validá-la.

---

## 1. Configuração recomendada

```ini
; /etc/asterisk/manager.conf

[general]
enabled = yes
port = 5038
; Escute só na interface por onde o backend do AstCall chega.
; Mesmo servidor: 127.0.0.1. Outra máquina: o IP da rede interna (nunca 0.0.0.0 exposto à internet).
bindaddr = 127.0.0.1

[astcall]
; Senha longa e aleatória (ex.: openssl rand -base64 32). Vai só no .env do AstCall.
secret = TROQUE-POR-UMA-SENHA-ALEATORIA

; Aceita conexões só do backend do AstCall
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255

; Classes de evento recebidas (ver seção 2)
read = system,call,agent
; Classes de action permitidas (ver seção 3) — SEM "command"
write = system,call,agent,originate,reporting

; Derruba o cliente se ele não consumir eventos a tempo (evita travar o Asterisk)
writetimeout = 5000

; ---- Filtros de eventos (ver seção 4) ----
; Com pelo menos um filtro de inclusão, SÓ os eventos que casam passam.
eventfilter = Event: Newchannel
eventfilter = Event: Newstate
eventfilter = Event: NewCallerid
eventfilter = Event: NewConnectedLine
eventfilter = Event: Rename
eventfilter = Event: Hangup
eventfilter = Event: Dial
eventfilter = Event: Hold
eventfilter = Event: Unhold
eventfilter = Event: MixMonitor
eventfilter = Event: Bridge
eventfilter = Event: BlindTransfer
eventfilter = Event: AttendedTransfer
eventfilter = Event: DeviceStateChange
eventfilter = Event: ContactStatus
eventfilter = Event: Queue
eventfilter = Event: Agent
eventfilter = Event: Confbridge
eventfilter = Event: ParkedCall
eventfilter = Event: UnParkedCall
eventfilter = Event: ChanSpy
eventfilter = Event: OriginateResponse
eventfilter = Event: FullyBooted
eventfilter = Event: Reload
; Itens das listas da sincronização (defensivo: ver nota na seção 4)
eventfilter = Event: EndpointList
eventfilter = Event: ContactList
eventfilter = Event: DeviceStateListComplete
eventfilter = Event: CoreShowChannel
eventfilter = Event: BridgeList
eventfilter = Event: ParkedCallsComplete
```

Depois de editar, aplique com `asterisk -rx "manager reload"` e ajuste o `.env` do AstCall:

```ini
AMI_PBX1_USERNAME=astcall
AMI_PBX1_SECRET=<a mesma senha do manager.conf>
```

---

## 2. Classes de leitura (`read`)

Define **quais eventos** o Asterisk envia. Só o necessário:

| Classe   | Por que é necessária                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `call`   | Canais, discagem, bridges, transferências, espera, gravação (`MixMonitor*`), estado de dispositivo, ConfBridge, estacionamento, `ChanSpy*` |
| `agent`  | Filas: membros, chamadores, `AgentCalled/Connect/Complete` (item 9)                                                                        |
| `system` | `ContactStatus` (registro dos ramais), `FullyBooted`, `Reload`                                                                             |

**Não** conceder:

| Classe                                                                     | Motivo                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `dialplan`                                                                 | `VarSet` e `Newexten`: o maior volume de eventos e o painel não precisa deles                |
| `security`                                                                 | `SuccessfulAuth`, `ChallengeSent`, `InvalidAccountID`... (interessa a um IDS, não ao painel) |
| `reporting`                                                                | `RTCP*`: estatísticas de mídia em alto volume                                                |
| `dtmf`, `agi`, `cdr`, `cel`, `log`, `verbose`, `user`, `config`, `command` | não usados                                                                                   |

> As classes cortam a maior parte do ruído antes mesmo dos filtros; o `eventfilter` refina dentro das
> classes concedidas (ex.: `ExtensionStatus` é da classe `call`, mas o AstCall não usa).

---

## 3. Classes de escrita (`write`) e actions usadas

Uma action é permitida se o usuário tiver **qualquer uma** das classes que ela exige.

| Action                                                                 | Uso no AstCall              | Classe esperada         |
| ---------------------------------------------------------------------- | --------------------------- | ----------------------- |
| `Login`, `Logoff`, `Ping`                                              | conexão e keepalive         | nenhuma                 |
| `PJSIPShowEndpoints`, `PJSIPShowContacts`                              | sincronização               | `system`                |
| `CoreShowChannels`                                                     | sincronização               | `system` ou `reporting` |
| `DeviceStateList`, `BridgeList`                                        | sincronização               | `call` ou `reporting`   |
| `QueueStatus`, `QueueSummary`                                          | sincronização (item 9)      | nenhuma / `reporting`   |
| `ConfbridgeListRooms`, `ConfbridgeList`, `ParkedCalls`                 | sincronização (itens 10–11) | `reporting` / `call`    |
| `Hangup`, `Redirect`, `BlindTransfer`, `Atxfer`, `Park`                | ações (item 12)             | `call`                  |
| `Originate` (inclui escuta com `ChanSpy`)                              | ações (itens 12 e 14)       | `originate`             |
| `QueueAdd`, `QueueRemove`, `QueuePause`, `QueuePenalty`                | ações (item 13)             | `agent`                 |
| `ConfbridgeKick`, `ConfbridgeMute`/`Unmute`, `ConfbridgeLock`/`Unlock` | ações (item 13)             | `call`                  |
| `MixMonitor`, `StopMixMonitor`                                         | ações (item 14)             | `call`                  |

**Confira no seu Asterisk** — a coluna "classe esperada" vem do código-fonte e pode variar entre versões:

```bash
asterisk -rx "manager show command PJSIPShowEndpoints"   # mostra "Privilege: ..."
asterisk -rx "manager show command CoreShowChannels"
asterisk -rx "manager show command Originate"
```

### Riscos conhecidos e como estão mitigados

- **`system` na escrita** é necessário para `PJSIPShowEndpoints`/`PJSIPShowContacts`, mas também
  libera actions administrativas como `ModuleLoad`/`Reload`. Mitigação: o navegador **nunca** fala com
  o AMI; o backend só envia uma lista fechada de actions (item 12, `ActionService`), sempre validando a
  permissão do usuário.
- **`Originate`** com aplicações perigosas (`System`, `Exec`...) exige a classe `system` e seria possível
  com esta configuração. Mitigação: o backend só origina com aplicações fixas (`Dial`, `ChanSpy`) e
  valida todos os parâmetros vindos do navegador (o cliente AMI também bloqueia quebras de linha).
- **`command` não é concedida**: o AstCall não executa comandos de CLI (diferente do MonAst).

---

## 4. Filtros de eventos (`eventfilter`)

- Sintaxe **clássica** (expressão regular sobre o texto do evento), aceita no Asterisk 20 e 22. As
  versões recentes também têm uma sintaxe avançada (`eventfilter(...)`), mas a clássica basta aqui.
- Cada `Event: X` casa **pelo prefixo**: `Event: Queue` cobre `QueueCallerJoin`, `QueueMemberStatus`
  etc.; `Event: Bridge` cobre `BridgeCreate/Enter/Leave/Destroy`. O efeito colateral (ex.: `Event:
Hangup` também deixa passar `HangupRequest`) é irrelevante em volume e os handlers ignoram o que
  não conhecem.
- Os itens de lista da sincronização (`EndpointList`, `CoreShowChannel`...) são respostas a actions e,
  pelo que o código do Asterisk indica, não passam pelo filtro. Mesmo assim estão incluídos: se algum
  for filtrado, a sincronização nunca termina (a lista não chega ao fim) e o AstCall reconecta em loop.
- Ao adicionar um domínio novo ao AstCall, acrescente aqui os eventos dele.

### Efeito medido no laboratório

Gravação real do laboratório (Asterisk 20, AzCall, 2026-10-16), só eventos assíncronos:

|                                               | Eventos        |
| --------------------------------------------- | -------------- |
| Total recebido (usuário `admin`, sem filtros) | 2846           |
| Passariam com esta configuração               | 715            |
| **Bloqueados**                                | **2131 (75%)** |

Mais bloqueados: `VarSet` 694, `ExtensionStatus` 618, `SuccessfulAuth` 121, `Newexten` 115,
`AGIExecStart/End` 202, `ChallengeSent` 95, `RTCPReceived/Sent` 129, `PeerStatus` 56, `DTMF*` 72.

> Sem `Newexten`, o campo "aplicação" dos canais só é preenchido na sincronização (`CoreShowChannel`).
> O painel não depende dele.

---

## 5. Opcional

```ini
[general]
; Acrescenta "Timestamp:" a cada evento (horário do Asterisk). O AstCall hoje usa o horário de
; chegada; com isso ligado, poderá usar o horário real do evento.
timestampevents = yes
```

- **Rede:** o AMI é texto puro (usuário, senha e eventos sem criptografia). Se o backend do AstCall não
  estiver no mesmo servidor, use rede interna/VPN e firewall liberando a porta 5038 só para o IP do
  backend. O suporte a AMI sobre TLS (`tlsenable`, porta 5039) ainda não existe no cliente do AstCall
  (ver roadmap).

---

## 6. Como validar

1. No Asterisk: `asterisk -rx "manager show user astcall"` — confira `read`, `write` e os filtros.
2. Ajuste o `.env` do AstCall e inicie o backend: `npm run dev:realtime`.
3. O log deve mostrar `connecting → syncing → ready` e "Estado sincronizado" com os endpoints.
   Se ficar repetindo `syncing` → `disconnected`, alguma lista está sendo bloqueada (permissão de
   escrita faltando ou filtro): o log mostra qual action falhou.
4. Faça uma chamada e confirme que ela aparece no painel.
5. Opcional: grave o tráfego (`AMI_RECORD_DIR=recordings`) por alguns minutos e confira que só
   chegam os eventos listados acima.

---

## Histórico de revisões

| Data       | Autor       | O que mudou                                                        |
| ---------- | ----------- | ------------------------------------------------------------------ |
| 2026-10-16 | Claude Code | Criação, com medição de volume a partir da gravação do laboratório |
