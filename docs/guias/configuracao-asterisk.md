# Configuração do Asterisk para o AstCall

> Para técnicos. Vale para os modos standalone e integrado. Explicação linha a linha (classes,
> actions usadas, riscos e medições): [manager.conf detalhado](../manager.conf.md).

O AstCall conversa com o Asterisk pelo **AMI** (Asterisk Manager Interface), com um usuário
próprio e **permissões mínimas**: ele recebe os eventos de chamadas, ramais e filas e pode executar
só as ações do painel — **nunca** comandos de CLI.

Versões suportadas: **Asterisk 20 LTS e 22 LTS**, com ramais em **PJSIP** e filas `app_queue`.

## 1. Criar o usuário AMI

Em `/etc/asterisk/manager.conf` (faça um backup antes):

```ini
[general]
enabled = yes
port = 5038
bindaddr = 127.0.0.1          ; mesmo servidor do AstCall; senão, o IP da rede interna

[astcall]
secret = <senha longa e aleatória: openssl rand -base64 32>
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255   ; só o servidor do AstCall
read = system,call,agent
write = system,call,agent,originate,reporting   ; SEM "command"
writetimeout = 5000
```

> No AzCall, o `manager.conf` pode já ter outros usuários: só **acrescente** a seção `[astcall]`.
> Nunca exponha a porta 5038 à internet.

## 2. Filtrar os eventos (recomendado)

Acrescente na seção `[astcall]` a lista de `eventfilter` do
[manager.conf detalhado, seção 1](../manager.conf.md#1-configuração-recomendada). Ela corta cerca de
**74% dos eventos** que o AstCall não usa, sem perder nada do painel.

## 3. Aplicar

```bash
asterisk -rx "manager reload"
asterisk -rx "manager show user astcall"     # confere read/write
```

O filtro só vale a partir do próximo login do AstCall: reinicie-o (`pm2 restart astcall`).

## 4. Informar ao AstCall

No `.env` do AstCall, com o `id` do servidor em `config/servers.json` (ex.: `pbx1`):

```ini
AMI_PBX1_USERNAME=astcall
AMI_PBX1_SECRET=<a mesma senha do manager.conf>
```

## 5. Conferir

- `pm2 logs astcall` mostra **Conectado e autenticado no AMI**, **Estado sincronizado** e status
  **ready**.
- `asterisk -rx "manager show connected"` lista o usuário `astcall`.
- Faça uma ligação entre dois ramais: ela aparece no painel em menos de um segundo.

## Problemas comuns

| Sintoma no log do AstCall             | Causa provável                                                  |
| ------------------------------------- | --------------------------------------------------------------- |
| `Authentication failed`               | usuário/senha diferentes entre `manager.conf` e `.env`          |
| conexão recusada / tempo esgotado     | `bindaddr`, `port`, firewall ou `permit` sem o IP do AstCall    |
| sincroniza mas filas não aparecem     | módulo `app_queue` não carregado (o resto funciona normalmente) |
| ações recusadas (`Permission denied`) | faltou alguma classe no `write`                                 |
