/**
 * Consulta o log de auditoria das ações (AUDIT_FILE).
 *
 * Uso (na raiz do repositório):
 *   npm run audit                          últimas 50 ações
 *   npm run audit -- --since hoje          desde 00:00 de hoje (ou 2026-10-17, ou 2h, 30m)
 *   npm run audit -- --user azcall:12      de um usuário (sub do token)
 *   npm run audit -- --action hangup       de uma ação
 *   npm run audit -- --failed              só as recusadas
 *   npm run audit -- --limit 200 --json    mais linhas / saída em JSON (uma por linha)
 *   npm run audit -- --file /caminho.jsonl outro arquivo
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { AuditEntry } from '../src/audit/AuditLog.js';
import { loadAuditFile } from '../src/config/index.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    since: { type: 'string' },
    user: { type: 'string' },
    action: { type: 'string' },
    failed: { type: 'boolean', default: false },
    limit: { type: 'string', default: '50' },
    json: { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(`Erro: ${msg}`);
  process.exit(1);
}

/** "hoje", "2026-10-17", "2h", "30m" → instante (ms). */
function parseSince(v: string): number {
  if (v === 'hoje') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const rel = /^(\d+)\s*([mhd])$/.exec(v);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
    return Date.now() - Number(rel[1]) * unit;
  }
  const t = new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime();
  if (Number.isNaN(t)) fail(`data inválida em --since: ${v}`);
  return t;
}

const file = values.file ?? loadAuditFile();
if (!file) fail('AUDIT_FILE não configurado no .env (ou informe --file)');
if (!existsSync(file)) fail(`arquivo não encontrado: ${file}`);
const since = values.since ? parseSince(values.since) : 0;
const limit = Math.max(1, Number(values.limit) || 50);

const rows: AuditEntry[] = [];
const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let e: AuditEntry;
  try {
    e = JSON.parse(line) as AuditEntry;
  } catch {
    continue; // linha corrompida (ex.: gravação interrompida)
  }
  if (since && new Date(e.ts).getTime() < since) continue;
  if (values.user && e.user !== values.user) continue;
  if (values.action && e.action !== values.action) continue;
  if (values.failed && e.ok) continue;
  rows.push(e);
  if (rows.length > limit) rows.shift(); // guarda só as últimas
}

if (values.json) {
  for (const e of rows) console.log(JSON.stringify(e));
} else if (rows.length === 0) {
  console.log('Nenhuma ação encontrada.');
} else {
  for (const e of rows) {
    const when = new Date(e.ts).toLocaleString('pt-BR');
    const who = e.name ? `${e.name} (${e.user})` : e.user;
    const result = e.ok ? 'OK' : `RECUSADA ${e.code ?? ''}: ${e.error ?? ''}`.trim();
    console.log(
      `${when}  ${who}  ${e.server}  ${e.action}  ${JSON.stringify(e.params)}  → ${result}`,
    );
  }
  console.log(`\n${rows.length} ação(ões).`);
}
