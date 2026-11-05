import type { EndpointQuality } from '@astcall/shared';
import type { AmiActionFields, AmiMessage } from '../ami/types.js';
import type { ServerStore } from '../state/ServerStore.js';
import { parseRtcpAll } from './rtcp.js';

export interface QualityMonitorOptions {
  /** Média de um endpoint abaixo disso marca `degradedSince` (padrão 70). */
  degradedBelow?: number;
  /** Máximo de canais medidos por rodada (proteção para PBX muito grande). */
  maxChannels?: number;
}

/** O que o monitor precisa da conexão AMI (interface mínima, testável). */
export interface QualitySource {
  sendAction(action: string, fields?: AmiActionFields, timeoutMs?: number): Promise<AmiMessage>;
}

/**
 * Qualidade de voz das conversas (item 28): a cada rodada consulta, com `Getvar`, o
 * `CHANNEL(rtcp,all)` de cada canal PJSIP em conversa e grava a nota no canal. Depois calcula a
 * média por endpoint (ramal ou tronco) e marca desde quando ela está abaixo do limite — o painel
 * avisa "tronco com qualidade degradada" quando isso dura alguns minutos.
 *
 * Uma consulta por canal e por rodada (padrão a cada 10 s, em main.ts); as consultas são feitas
 * uma de cada vez para não encher o AMI. Canal que terminou no meio da rodada só dá erro, ignorado.
 */
export class QualityMonitor {
  private readonly degradedBelow: number;
  private readonly maxChannels: number;
  private running = false;

  constructor(options: QualityMonitorOptions = {}) {
    this.degradedBelow = options.degradedBelow ?? 70;
    this.maxChannels = options.maxChannels ?? 500;
  }

  /** Uma rodada de medição. Se a anterior ainda não terminou, não faz nada. */
  async update(store: ServerStore, ami: QualitySource, now = () => Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const channels = [...store.channels.values()]
        .filter((c) => c.state === 'Up' && c.name.startsWith('PJSIP/') && !c.isLocal)
        .slice(0, this.maxChannels);
      for (const ch of channels) {
        let value: string | undefined;
        try {
          const res = await ami.sendAction(
            'Getvar',
            { Channel: ch.name, Variable: 'CHANNEL(rtcp,all)' },
            5_000,
          );
          value = res.value;
        } catch {
          continue; // canal terminou, ou o AMI recusou: segue para o próximo
        }
        store.setChannelQuality(ch.uniqueid, parseRtcpAll(value, now()));
      }
      this.updateEndpoints(store, now());
      store.flush(now());
    } finally {
      this.running = false;
    }
  }

  /** Média por endpoint das notas dos canais em conversa; sem canal medido = null. */
  private updateEndpoints(store: ServerStore, ts: number): void {
    const byEndpoint = new Map<string, number[]>();
    for (const ch of store.channels.values()) {
      if (!ch.endpointId || !ch.quality || ch.state !== 'Up') continue;
      (byEndpoint.get(ch.endpointId) ?? byEndpoint.set(ch.endpointId, []).get(ch.endpointId)!).push(
        ch.quality.mes,
      );
    }
    for (const ep of store.endpoints.values()) {
      const notes = byEndpoint.get(ep.id);
      if (!notes) {
        if (ep.quality) store.setEndpointQuality(ep.id, null);
        continue;
      }
      const mes = Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 10) / 10;
      const below = mes < this.degradedBelow;
      const quality: EndpointQuality = {
        mes,
        channels: notes.length,
        degradedSince: below ? (ep.quality?.degradedSince ?? ts) : null,
        updatedAt: ts,
      };
      store.setEndpointQuality(ep.id, quality);
    }
  }
}
