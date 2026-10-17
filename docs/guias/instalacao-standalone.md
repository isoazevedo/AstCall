# Instalação standalone (servidor próprio)

> Para técnicos. Resultado: o AstCall rodando num servidor Linux, com login próprio, atrás do
> Nginx com HTTPS. Para usar como módulo do AzCall, veja [Instalação no AzCall](instalacao-azcall.md).

```
navegador ──HTTPS──► Nginx ──► painel (arquivos estáticos)
                       ├─/auth, /admin ──────► backend AstCall :8090 (Node.js)
                       └─/monitor-ws (WebSocket) ┘        │ AMI (TCP 5038)
                                                          ▼
                                                      Asterisk 20/22
```

## 1. Requisitos

- Linux (testado em Debian 11/12 e Ubuntu 22.04/24.04), 1 vCPU e 1 GB de RAM bastam para
  centenas de ramais (ver [testes de carga](../CARGA.md)).
- **Node.js 22 ou superior** (o login standalone usa o SQLite nativo do Node 22).
- Nginx e um certificado HTTPS (ex.: Let's Encrypt). O cookie de login só trafega por HTTPS.
- Acesso AMI ao Asterisk 20 ou 22 — prepare o usuário antes:
  [Configuração do Asterisk](configuracao-asterisk.md).

```bash
# Node 22 (NodeSource) e PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
node -v   # v22.x ou superior
```

## 2. Código e build

```bash
sudo git clone <url-do-repositório> /opt/astcall
cd /opt/astcall
npm ci
npm run build          # shared, backend e painel
```

## 3. Configuração

```bash
cp .env.example .env && chmod 600 .env
cp config/servers.example.json config/servers.json
```

`config/servers.json` — um item por Asterisk (sem senhas):

```json
{
  "servers": [
    { "id": "pbx1", "name": "PBX Matriz", "host": "127.0.0.1", "port": 5038, "enabled": true }
  ]
}
```

`.env` — o essencial:

```ini
NODE_ENV=production
HTTP_HOST=127.0.0.1          # só o Nginx acessa o backend
HTTP_PORT=8090
TRUST_PROXY=true             # IP real do cliente vem do Nginx

# Credenciais AMI de cada servidor (AMI_<ID>_USERNAME / AMI_<ID>_SECRET)
AMI_PBX1_USERNAME=astcall
AMI_PBX1_SECRET=<senha do usuário AMI>

AUTH_MODE=local
# Auditoria das ações (recomendado)
AUDIT_FILE=/var/log/astcall/audit.jsonl
```

Os demais itens do `.env.example` têm valores padrão adequados (validade do acesso, arquivos de
chaves e do banco de usuários, intervalos de reconciliação).

## 4. Chaves e primeiro administrador

```bash
npm run keys:generate        # chaves do login (keys/), não versionadas
npm run user add admin       # pergunta nome, permissões (responda "all") e senha
```

Os próximos usuários podem ser criados pela tela **Usuários** do painel.

## 5. Iniciar com PM2

```bash
pm2 start apps/realtime/dist/main.js --name astcall --cwd /opt/astcall \
  --node-args="--disable-warning=ExperimentalWarning" --time
pm2 save
pm2 startup                  # siga a instrução impressa para iniciar com o servidor
pm2 logs astcall             # deve mostrar "Estado sincronizado" e status "ready"
```

## 6. Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name monitor.suaempresa.com.br;
    ssl_certificate     /etc/letsencrypt/live/monitor.suaempresa.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/monitor.suaempresa.com.br/privkey.pem;

    # Painel (SPA)
    root /opt/astcall/apps/web/dist;
    location / { try_files $uri /index.html; }

    # API de login e de usuários
    location ~ ^/(auth|admin)/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Tempo real (WebSocket)
    location /monitor-ws {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;   # a conexão fica aberta o tempo todo
    }

    # Web Component para embutir em outras páginas (opcional)
    location /static/ { proxy_pass http://127.0.0.1:8090; }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Abra `https://monitor.suaempresa.com.br`, entre com o `admin` e confira o selo **Tempo real**.

## 7. Auditoria e rotação de logs

```bash
sudo mkdir -p /var/log/astcall
npm run audit -- --since hoje          # consulta as ações registradas
```

Rotação: veja [Auditoria](../AUDITORIA.md) (logrotate com `copytruncate`).

## 8. Atualização

```bash
cd /opt/astcall
git pull
npm ci && npm run build
pm2 restart astcall
```

## 9. Backup

Guarde `/opt/astcall/.env`, `config/servers.json`, `keys/` e `data/users.sqlite` (usuários e
sessões). O estado das chamadas não precisa de backup: vem do Asterisk a cada conexão.

## Problemas comuns

| Sintoma                                      | Verifique                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Selo **PBX desconectado**                    | `pm2 logs astcall`; usuário/senha AMI no `.env`; `permit` e `bindaddr` no `manager.conf`                     |
| Login volta sempre para a tela de entrada    | Site sem HTTPS (o cookie exige HTTPS em produção) ou `/auth` sem proxy no Nginx                              |
| Painel abre mas fica em **Conectando…**      | Bloco `/monitor-ws` do Nginx (cabeçalhos `Upgrade`/`Connection`)                                             |
| Tela **Usuários** dá erro                    | Falta o proxy de `/admin` no Nginx                                                                           |
| "Nenhum usuário pode gerenciar usuários"     | `npm run user perms admin` e responda `all`                                                                  |
| Chamadas "fantasmas" aparecem com frequência | Perda de eventos AMI: veja `writetimeout` e o filtro em [Configuração do Asterisk](configuracao-asterisk.md) |
