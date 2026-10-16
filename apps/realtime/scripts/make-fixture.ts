/**
 * Gera uma fixture de teste a partir de uma gravação do AmiRecorder.
 *
 * Uso:
 *   npx tsx scripts/make-fixture.ts <gravacao.jsonl> <saida.jsonl> <HH:MM:SS inicio> <HH:MM:SS fim>
 *
 * - Recorta o intervalo de horário (hora local da máquina).
 * - Descarta eventos irrelevantes para o painel e eventos de segurança.
 * - Substitui IPs por endereços de documentação (192.0.2.0/24), de forma consistente.
 *
 * Revise a saída antes de versionar: nomes e números de clientes reais também devem ser trocados.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { RecordLine } from '../src/ami/AmiRecorder.js';

const DROP = new Set([
  'VarSet',
  'RTCPSent',
  'RTCPReceived',
  'SuccessfulAuth',
  'ChallengeSent',
  'InvalidAccountID',
  'InvalidPassword',
  'ChallengeResponseFailed',
  'FailedACL',
  'AGIExecStart',
  'AGIExecEnd',
  'DTMFBegin',
  'DTMFEnd',
  'ExtensionStatus',
  'PeerStatus',
  'Registry',
]);

const [input, output, from, to] = process.argv.slice(2);
if (!input || !output || !from || !to) {
  console.error('Uso: make-fixture.ts <gravacao.jsonl> <saida.jsonl> <HH:MM:SS> <HH:MM:SS>');
  process.exit(1);
}

const ips = new Map<string, string>();
const anonymize = (v: string) =>
  v.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => {
    if (ip === '127.0.0.1' || ip === '0.0.0.0') return ip;
    if (!ips.has(ip)) ips.set(ip, `192.0.2.${ips.size + 1}`);
    return ips.get(ip)!;
  });

const out: string[] = [];
for (const raw of readFileSync(input, 'utf8').trim().split('\n')) {
  const line = JSON.parse(raw) as RecordLine;
  const hhmmss = new Date(line.t).toTimeString().slice(0, 8);
  if (hhmmss < from || hhmmss > to) continue;
  if ('status' in line) {
    out.push(JSON.stringify(line));
    continue;
  }
  const { msg } = line;
  if (!msg.event || DROP.has(msg.event)) continue; // respostas de actions e ruído
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'privilege' || k === 'actionid') continue;
    clean[k] = anonymize(v);
  }
  out.push(JSON.stringify({ t: line.t, msg: clean }));
}

writeFileSync(output, out.join('\n') + '\n');
console.log(`${out.length} linhas gravadas em ${output} (${ips.size} IPs anonimizados)`);
