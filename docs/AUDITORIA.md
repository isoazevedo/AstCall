# Auditoria das ações

> Última revisão: 2026-10-17

Toda ação pedida pelo painel (pausar, adicionar/remover membro, penalidade, desligar,
transferir, ligar, escutar) é registrada — executada ou recusada.

## Configuração

No `.env` do AstCall:

```ini
AUDIT_FILE=/var/log/astcall/audit.jsonl
```

A pasta é criada se não existir. Sem `AUDIT_FILE`, as ações aparecem só no log geral
(`pm2 logs astcall`, campo `mod: "audit"`).

## Formato

Uma linha JSON por ação:

```json
{
  "ts": "2026-10-17T14:05:12.345Z",
  "user": "azcall:12",
  "name": "Maria Supervisora",
  "iss": "azcall",
  "server": "pbx1",
  "action": "queueAdd",
  "params": { "queue": "suporte-default", "endpoint": "9005", "penalty": 0, "paused": false },
  "ok": true,
  "ami": ["QueueAdd"]
}
```

Recusadas trazem `"ok": false`, `code` (`forbidden`, `not_found`, `invalid`, `rate_limited`,
`ami_error`, `disconnected`...) e `error` (mensagem mostrada ao usuário).

## Consulta

Na raiz do AstCall:

```bash
npm run audit                          # últimas 50 ações
npm run audit -- --since hoje          # desde 00:00 (também 2026-10-17, 2h, 30m)
npm run audit -- --user azcall:12      # de um usuário (sub do token)
npm run audit -- --action hangup       # de uma ação
npm run audit -- --failed              # só as recusadas
npm run audit -- --limit 200 --json    # mais linhas / JSON por linha
```

## Rotação (logrotate)

O arquivo fica aberto em modo append, então use `copytruncate`:

```
# /etc/logrotate.d/astcall
/var/log/astcall/audit.jsonl {
    weekly
    rotate 52
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

Com `rotate 52` e `weekly`, fica um ano de histórico. `npm run audit` lê só o arquivo atual;
para os antigos use `--file` (descompactado).

## Histórico de revisões

| Data       | Autor       | O que mudou     |
| ---------- | ----------- | --------------- |
| 2026-10-17 | Claude Code | Versão inicial. |
