# Integração AstCall × AzCall (modo integrado)

> Contrato entre o AstCall (backend Node + Web Component) e o AzCall (PHP).
> Versão do contrato: **1.1** · Última revisão: 2026-10-17

O AzCall embute o painel AstCall numa página própria, autentica o usuário (sem segundo login)
e emite o token. O AstCall só **valida** o token e aplica permissões e escopo que vêm nele.

```
Navegador ── GET  /astcall ─────────────────────► AzCall (PHP)  página com <ast-monitor>
          ── POST /astcall/token (cookie) ──────► AzCall (PHP)  { token, expiresAt }
          ── GET  /astcall/static/ast-monitor.js ► Apache ─proxy─► AstCall :8090 /static/...
          ── WS   /astcall/monitor-ws ───────────► Apache ─proxy─► AstCall :8090 /monitor-ws
                                                                     │ AMI (127.0.0.1:5038)
                                                                     ▼
                                                                  Asterisk
```

---

## 1. Os três contratos estáveis

Mudanças incompatíveis em qualquer um deles exigem nova versão deste documento.

### 1.1 Tag do Web Component

```html
<script type="module" src="/astcall/static/ast-monitor.js"></script>
<ast-monitor ws-url="/astcall/monitor-ws" token-url="/astcall/token"></ast-monitor>
```

| Atributo    | Obrigatório | Descrição                                              |
| ----------- | ----------- | ------------------------------------------------------ |
| `token-url` | sim         | `POST` com o cookie da sessão → `{ token, expiresAt }` |
| `ws-url`    | não         | WebSocket do AstCall (padrão `/monitor-ws`)            |
| `mode`      | não         | `panel` (padrão) ou `tv` — modo TV, ver 1.4            |
| `rotate`    | não         | modo TV: segundos do rodízio (padrão 15; `0` = parado) |

| Evento DOM      | Quando                                                   | O que o AzCall faz      |
| --------------- | -------------------------------------------------------- | ----------------------- |
| `auth-required` | `token-url` respondeu 401/403 (sessão do AzCall expirou) | redireciona ao `/login` |

**Tema:** o componente usa as variáveis `--bs-*` da página (Frest). No modo escuro o AzCall
define `--ast-card-bg` (o tema não expõe a cor do card na raiz) — ver `views/astcall/index.php`.

### 1.2 Endpoint de token (`token-url`)

- `POST`, autenticado pela sessão (cookie) do AzCall. **Sempre responde JSON.**
- `200` → `{ "token": "<JWT>", "expiresAt": <ms desde 1970> }`
- `401` → sessão expirada · `403` → sem permissão `astcall.view` ou módulo desligado.
- O painel chama ao conectar, ao reconectar e ~1 min antes de `expiresAt`.

### 1.3 Token (JWT RS256)

| Claim       | Tipo                                                          | Descrição                                                      |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `iss`       | string                                                        | `azcall` (precisa constar em `EXTERNAL_JWT_ISSUER` do AstCall) |
| `sub`       | string                                                        | `azcall:<id do usuário>`                                       |
| `name`      | string                                                        | nome de exibição                                               |
| `iat`/`exp` | número (s)                                                    | validade curta (padrão 600 s)                                  |
| `perms`     | `{ "<servidor>": Permissão[] }`                               | `view`, `hangup`, `transfer`, `originate`, `spy`, `queue`      |
| `scope`     | `{ "<servidor>": { endpoints: string[], queues: string[] } }` | **opcional**; ausente = vê tudo naquele servidor (super_admin) |
| `extension` | string                                                        | **opcional**; ramal do usuário (sugestão no diálogo de escuta) |

**Mapeamento de permissões** (AzCall → AstCall), em `AstCallTokenService::PERMISSION_MAP`:
`astcall.view → view`, `astcall.hangup → hangup`, `astcall.transfer → transfer`,
`astcall.originate → originate`, `astcall.spy → spy`, `astcall.queue → queue`.
`super_admin` recebe todas.

**Escopo (multi-empresa):** para quem não é `super_admin`, o AzCall lista os nomes dos
endpoints PJSIP da empresa (`extensions.extension` e `trunks.trunk_name`) e das filas no
Asterisk (`<queue_name>-<company_id>`). O AstCall então:

- mostra só esses endpoints e filas (e seus membros/chamadores);
- mostra uma chamada se **algum** canal dela for de um endpoint do escopo ou tiver passado por
  uma fila do escopo — e, nesse caso, mostra a chamada inteira (inclusive o outro lado);
- recusa ações fora do escopo (responde "não encontrado"); "pausar em todas as filas" vira uma
  pausa por fila da empresa.

Alterações de permissão/escopo no AzCall valem na próxima renovação do token (≤ 10 min).

### 1.4 Modo TV (wallboard)

`<ast-monitor mode="tv">` troca o painel de operação por uma tela escura, só leitura, para
deixar numa TV: telas **Filas** e **Chamadas** (chamadas em curso + mapa de ramais).

- **Rodízio:** alterna as telas a cada `rotate` segundos (padrão 15, entre 5 e 600). O usuário
  liga/desliga o rodízio e escolhe a tela na própria TV; a escolha fica no `localStorage` do
  navegador (chave `astcall.tv`) e prevalece sobre o atributo. `rotate="0"` faz o rodízio começar
  desligado.
- **Tela cheia:** botão na própria tela (o navegador exige um clique).
- **Paleta:** escura e fixa; personalizável por `--ast-tv-bg`, `--ast-tv-card-bg`, `--ast-tv-text`,
  `--ast-tv-text-muted`, `--ast-tv-heading`, `--ast-tv-border`.
- Mesmas permissões e escopo do painel (precisa só de `astcall.view`); nenhuma ação é oferecida.

No AzCall: `GET /astcall/tv` (página sem o layout, `?rotate=N` opcional) e botão "Modo TV" em
`/astcall`. Sessão: o PHP só envia o cookie de sessão no login, então ele venceria
`SESSION_LIFETIME` (padrão 2 h) depois do login mesmo com a TV ligada. Por isso
`POST /astcall/token` reenvia o cookie com novo vencimento a cada renovação (~9 min): enquanto
o painel estiver aberto, a sessão continua válida. Se ela expirar mesmo assim (logout,
reinício do servidor), a página volta ao login.

---

## 2. Instalação (servidor do AzCall)

Feita no laboratório em 2026-10-17 (Debian 11, Node 20, PM2, Apache 2.4).

### 2.1 AstCall

```bash
# código em /opt/astcall (git), dependências e build
cd /opt/astcall && npm ci
npm run build -w @astcall/shared && npm run build -w @astcall/realtime
(cd apps/web && npx vite build --mode element)
```

`/opt/astcall/.env` (permissão 600):

```ini
NODE_ENV=production
HTTP_HOST=127.0.0.1
HTTP_PORT=8090
TRUST_PROXY=true
SERVERS_FILE=config/servers.json
AMI_PBX1_USERNAME=astcall
AMI_PBX1_SECRET=<senha do usuário AMI>
AUTH_MODE=external
EXTERNAL_JWT_ISSUER=azcall
EXTERNAL_JWT_PUBLIC_KEY_FILE=/opt/astcall-keys/azcall-public.pem
```

`config/servers.json`: `{ "servers": [ { "id": "pbx1", "name": "AzCall", "host": "127.0.0.1", "port": 5038 } ] }`

```bash
pm2 start apps/realtime/dist/main.js --name astcall --cwd /opt/astcall \
  --node-args="--disable-warning=ExperimentalWarning" --time
pm2 save
```

> O modo integrado não usa o banco de usuários (`node:sqlite`), então roda em Node 20.

### 2.2 Chaves

```bash
cd /var/www/html/azcall && mkdir -p storage/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out storage/keys/astcall-private.pem
chown root:www-data storage/keys storage/keys/astcall-private.pem
chmod 750 storage/keys && chmod 640 storage/keys/astcall-private.pem
mkdir -p /opt/astcall-keys
openssl pkey -in storage/keys/astcall-private.pem -pubout -out /opt/astcall-keys/azcall-public.pem
```

`storage/keys/` está no `.gitignore` do AzCall.

### 2.3 AzCall

- `.env`: `ASTCALL_JWT_PRIVATE_KEY`, `ASTCALL_SERVER_ID=pbx1`, `ASTCALL_TOKEN_TTL=600`,
  `ASTCALL_ISSUER=azcall`.
- Migration: `php console migrate:run 161_seed_astcall_permissions.php`.
- Ligar o módulo: **Configurações → Módulo AstCall** (super_admin). Desligado por padrão.

### 2.4 Apache (vhost do AzCall, HTTPS)

```apache
ProxyPass        "/astcall/monitor-ws"  "ws://127.0.0.1:8090/monitor-ws"
ProxyPassReverse "/astcall/monitor-ws"  "ws://127.0.0.1:8090/monitor-ws"
ProxyPass        "/astcall/static/"     "http://127.0.0.1:8090/static/"
ProxyPassReverse "/astcall/static/"     "http://127.0.0.1:8090/static/"
```

Requer `proxy`, `proxy_http` e `proxy_wstunnel`. `/astcall` e `/astcall/token` **não** passam
pelo proxy (são rotas do PHP). Evite prefixos que colidam com o `ProxyPass "/monitor"` existente.

### 2.5 AMI

Usuário `astcall` conforme `docs/manager.conf.md`, com `permit=127.0.0.1/255.255.255.255`
(o backend roda no próprio servidor).

---

## 3. Atualização

```bash
cd /opt/astcall && git pull   # ou git fetch de um bundle
npm ci && npm run build -w @astcall/shared && npm run build -w @astcall/realtime
(cd apps/web && npx vite build --mode element)
pm2 restart astcall
```

O navegador revalida o `ast-monitor.js` (ETag) a cada carga da página.

---

## Histórico de revisões

| Data       | Autor       | O que mudou                                                                     |
| ---------- | ----------- | ------------------------------------------------------------------------------- |
| 2026-10-17 | Claude Code | Versão 1 do contrato; instalação no laboratório                                 |
| 2026-10-17 | Claude Code | Versão 1.1: atributos opcionais `mode` e `rotate` (modo TV), rota `/astcall/tv` |
