import type { VoiceQuality } from '@astcall/shared';

/**
 * Lê o resultado de `CHANNEL(rtcp,all)` do chan_pjsip (Asterisk 20/22), uma linha
 * `chave=valor;...`, por exemplo:
 *
 *   ssrc=1608644528;themssrc=1174164631;lp=1;rxjitter=0.018375;rxcount=1397;
 *   txjitter=0.002000;txcount=1398;rlp=0;rtt=0.045532;rxmes=87.600735;txmes=87.424566
 *
 * - `rxmes`/`txmes`: nota MES (0–100) de cada sentido; vale o pior dos dois;
 * - `rxjitter`/`txjitter` e `rtt`: em segundos;
 * - `lp`/`rlp`: pacotes perdidos recebendo / informados pelo outro lado; `rxcount`/`txcount`:
 *   pacotes recebidos / enviados.
 *
 * Devolve null quando não há medição (canal sem RTP pelo Asterisk, ex.: direct_media, ou
 * antes do primeiro relatório).
 */
export function parseRtcpAll(value: string | undefined, now: number): VoiceQuality | null {
  if (!value) return null;
  const f = new Map<string, number>();
  for (const part of value.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const n = Number(part.slice(i + 1).trim());
    if (Number.isFinite(n)) f.set(part.slice(0, i).trim(), n);
  }
  const mes = [f.get('rxmes'), f.get('txmes')].filter((m): m is number => m !== undefined && m > 0);
  if (mes.length === 0) return null;

  const lossOf = (lost: number | undefined, count: number | undefined) =>
    lost !== undefined && count !== undefined && lost + count > 0
      ? (lost / (lost + count)) * 100
      : 0;
  const rtt = f.get('rtt');
  return {
    mes: round1(Math.min(...mes)),
    jitterMs: round1(Math.max(f.get('rxjitter') ?? 0, f.get('txjitter') ?? 0) * 1000),
    rttMs: rtt !== undefined && rtt > 0 ? Math.round(rtt * 1000) : null,
    lossPct: round1(
      Math.max(lossOf(f.get('lp'), f.get('rxcount')), lossOf(f.get('rlp'), f.get('txcount'))),
    ),
    updatedAt: now,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
