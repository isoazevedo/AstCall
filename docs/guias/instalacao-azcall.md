# Instalação como módulo do AzCall

> Para técnicos que administram o AzCall. Resultado: menu **Monitoramento → AstCall** no AzCall,
> sem segundo login, com cada empresa vendo só os próprios ramais, filas e chamadas.
> Detalhes técnicos (formato do token, atributos, versões): [contrato de integração](../INTEGRACAO_AZCALL.md).

```
Navegador ── /astcall, /astcall/token ─────────► AzCall (PHP): página e login
          ── /astcall/static, /astcall/monitor-ws ► Apache ─proxy─► AstCall :8090 (Node.js)
                                                                      │ AMI
                                                                      ▼
                                                                   Asterisk
```

O AzCall continua dono dos usuários e das permissões; ele emite um "crachá" de curta duração
(token) que o AstCall confere. O AstCall roda no **mesmo servidor** do AzCall.

## Resumo dos passos

1. **Usuário AMI** do AstCall no Asterisk (sem acesso a comandos de CLI) —
   [Configuração do Asterisk](configuracao-asterisk.md).
2. **AstCall** em `/opt/astcall`, com Node 20 ou superior e PM2 (o modo integrado não usa o banco
   de usuários do standalone):

   ```bash
   cd /opt/astcall && npm ci
   npm run build -w @astcall/shared && npm run build -w @astcall/realtime
   (cd apps/web && npx vite build --mode element)
   ```

   `.env` com `AUTH_MODE=external`, `HTTP_HOST=127.0.0.1`, `HTTP_PORT=8090`, `TRUST_PROXY=true`,
   as credenciais AMI e `EXTERNAL_JWT_PUBLIC_KEY_FILE` (passo 3). Inicie com
   `pm2 start apps/realtime/dist/main.js --name astcall --cwd /opt/astcall` e `pm2 save`.

3. **Chaves**: o AzCall assina com a chave privada (fica em `storage/keys/` do AzCall, fora do
   git); o AstCall confere com a pública. Comandos em
   [contrato, seção 2.2](../INTEGRACAO_AZCALL.md#22-chaves).
4. **AzCall**: variáveis `ASTCALL_*` no `.env` e as migrations de permissões
   (`161_seed_astcall_permissions.php` e `162_seed_astcall_queue_manage.php`).
5. **Apache**: dois proxies no vhost do AzCall — `/astcall/monitor-ws` (WebSocket) e
   `/astcall/static/` — com os módulos `proxy`, `proxy_http` e `proxy_wstunnel`.
   [Trecho pronto](../INTEGRACAO_AZCALL.md#24-apache-vhost-do-azcall-https).
6. **Ligar o módulo**: **Configurações → Módulo AstCall** (super_admin). Desligado por padrão.

## Permissões por função

Em **Funções & Permissões** do AzCall, cada função recebe as permissões do AstCall:

| Permissão              | Libera                                       | Padrão                    |
| ---------------------- | -------------------------------------------- | ------------------------- |
| `astcall.view`         | ver o painel e o modo TV                     | admin, supervisor, viewer |
| `astcall.originate`    | **Ligar** a partir de um ramal               | admin, supervisor         |
| `astcall.hangup`       | **Desligar**                                 | admin, supervisor         |
| `astcall.transfer`     | **Transferir**                               | admin, supervisor         |
| `astcall.spy`          | **Escutar / sussurrar / intervir**           | admin, supervisor         |
| `astcall.queue`        | **Pausar / retomar** atendentes              | admin, supervisor         |
| `astcall.queue_manage` | **Adicionar / remover** membros e penalidade | admin, supervisor         |

O `super_admin` vê todas as empresas; os demais veem só a própria. Mudanças valem em até 10
minutos.

## Conferindo

- [ ] `pm2 logs astcall` mostra **Estado sincronizado** e status **ready**.
- [ ] `https://<seu-azcall>/astcall/static/ast-monitor.js` responde (proxy do Apache).
- [ ] Menu **Monitoramento → AstCall** aparece para quem tem `astcall.view` e o selo fica em
      **Tempo real**.
- [ ] Um usuário de uma empresa vê só os ramais e filas dela.
- [ ] **Modo TV** abre em `/astcall/tv`.

## Atualização

```bash
cd /opt/astcall && git pull
npm ci && npm run build -w @astcall/shared && npm run build -w @astcall/realtime
(cd apps/web && npx vite build --mode element)
pm2 restart astcall
```

O navegador busca o `ast-monitor.js` novo sozinho na próxima vez que a página abrir.

## Problemas comuns

| Sintoma                           | Verifique                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Menu AstCall não aparece          | Módulo ligado em Configurações e permissão `astcall.view` na função do usuário |
| Página abre vazia                 | Proxy `/astcall/static/` no Apache; AstCall rodando (`pm2 status`)             |
| Fica em **Conectando…**           | Proxy `/astcall/monitor-ws` e o módulo `proxy_wstunnel`                        |
| **Sessão expirada** logo ao abrir | Chave pública do AstCall diferente da privada do AzCall; relógio do servidor   |
| Empresa vê ramais de outra        | Usuário com função `super_admin` vê tudo por definição                         |
