import { OFFLINE_DEVICE_STATES, type QueueForecast } from '@astcall/shared';
import type { AmiMessage } from '../ami/types.js';
import type { ServerStore } from '../state/ServerStore.js';
import { agentsNeeded, serviceLevel } from './erlang.js';

export interface ForecastOptions {
  /** Janela de cálculo (min). Padrão 15, como nos relatórios de call center. */
  windowMin?: number;
  /** Meta de nível de serviço (%). O Asterisk só guarda o tempo da meta, não o percentual. */
  slTarget?: number;
  /** Tempo da meta (s) quando a fila não tem `servicelevel` configurado. */
  defaultSlSeconds?: number;
  /** Início do monitoramento (ms): antes de completar uma janela, a previsão está "aquecendo". */
  startedAt?: number;
}

/** Quanto tempo de histórico guardar por fila: a janela atual mais a anterior (tendência). */
const HISTORY_MS = 60 * 60_000;
/** Janela "recente" usada para a tendência. */
const RECENT_MS = 5 * 60_000;

interface History {
  /** Entradas na fila (ms). */
  joins: number[];
  /** Atendimentos concluídos: quando, espera e conversa (s). */
  answers: { at: number; talk: number }[];
}

/**
 * Previsão das filas (item 26 do roadmap).
 *
 * Guarda em memória o histórico recente de cada fila, a partir dos eventos do AMI
 * (`QueueCallerJoin` e `AgentComplete`), e a cada poucos segundos calcula, por fila:
 * ritmo de entrada, tempo médio de atendimento, nível de serviço previsto e atendentes
 * necessários (Erlang C), tendência, risco e o horário estimado de atendimento de cada
 * chamador. O resultado vai para o store como `queueForecast` e chega aos painéis por delta.
 *
 * O histórico não é apagado na ressincronização com o AMI; só se perde se o backend
 * reiniciar (aí a previsão volta a "aquecer" por uma janela).
 */
export class QueueForecaster {
  private readonly history = new Map<string, History>();
  private readonly windowMs: number;
  private readonly slTarget: number;
  private readonly defaultSlSeconds: number;
  private readonly startedAt: number;

  constructor(options: ForecastOptions = {}) {
    this.windowMs = (options.windowMin ?? 15) * 60_000;
    this.slTarget = options.slTarget ?? 80;
    this.defaultSlSeconds = options.defaultSlSeconds ?? 20;
    this.startedAt = options.startedAt ?? Date.now();
  }

  /** Registra os eventos que interessam à previsão. */
  onEvent(ev: AmiMessage, ts = Date.now()): void {
    if (!ev.queue) return;
    switch (ev.event?.toLowerCase()) {
      case 'queuecallerjoin':
        this.of(ev.queue).joins.push(ts);
        break;
      case 'agentcomplete':
        this.of(ev.queue).answers.push({ at: ts, talk: Number(ev.talktime) || 0 });
        break;
      default:
        return;
    }
    this.prune(ev.queue, ts);
  }

  /** Calcula a previsão de todas as filas e grava no store (gera deltas se algo mudou). */
  update(store: ServerStore, now = Date.now()): void {
    for (const name of store.queues.keys())
      store.setForecast(name, this.forecast(store, name, now));
    store.flush(now);
  }

  /** Previsão de uma fila agora. */
  forecast(store: ServerStore, queue: string, now = Date.now()): QueueForecast {
    const h = this.of(queue);
    this.prune(queue, now);
    const q = store.queues.get(queue);
    const slSeconds = q && q.serviceLevel > 0 ? q.serviceLevel : this.defaultSlSeconds;
    const warming = now - this.startedAt < this.windowMs;

    // Janela efetiva: antes de completar 15 min de monitoramento, usa o que tem (mínimo 5 min,
    // para uma única chamada não virar um "ritmo" enorme).
    const windowMs = Math.min(this.windowMs, Math.max(now - this.startedAt, RECENT_MS));
    const from = now - windowMs;
    const joins = h.joins.filter((t) => t >= from);
    const answers = h.answers.filter((a) => a.at >= from);
    const arrivalsPerMin = joins.length / (windowMs / 60_000);

    // Tempo médio de atendimento: o da janela; sem atendimento na janela, a média do Asterisk.
    const aht = answers.length
      ? answers.reduce((s, a) => s + a.talk, 0) / answers.length
      : q && q.talktime > 0
        ? q.talktime
        : null;

    // Atendentes disponíveis: logados na fila, não pausados e com telefone registrado.
    const members = [...store.queueMembers.values()].filter(
      (m) => m.queue === queue && !m.paused && !OFFLINE_DEVICE_STATES.includes(m.status),
    );
    const agents = members.length;
    const waiting = [...store.queueEntries.values()]
      .filter((e) => e.queue === queue)
      .sort((a, b) => a.position - b.position);

    let slForecast: number | null = null;
    let needed: number | null = null;
    if (joins.length > 0 && aht) {
      const traffic = (arrivalsPerMin / 60) * aht;
      slForecast = Math.round(serviceLevel(agents, traffic, aht, slSeconds) * 100);
      needed = agentsNeeded(traffic, aht, slSeconds, this.slTarget / 100);
    }

    const longestWait = waiting.length
      ? (now - Math.min(...waiting.map((e) => e.joinedAt))) / 1000
      : 0;
    let risk: QueueForecast['risk'] = 'ok';
    if (waiting.length > 0 && agents === 0) risk = 'high';
    else if (slForecast !== null) {
      if (slForecast < this.slTarget - 15) risk = 'high';
      else if (slForecast < this.slTarget) risk = 'warn';
    } else if (longestWait > slSeconds) risk = 'warn';

    return {
      queue,
      status: warming ? 'warming' : joins.length === 0 ? 'idle' : 'ok',
      windowMin: Math.round(windowMs / 60_000),
      arrivalsPerMin: Math.round(arrivalsPerMin * 10) / 10,
      ahtSec: aht === null ? null : Math.round(aht),
      agentsAvailable: agents,
      agentsNeeded: needed,
      slForecast,
      slTarget: this.slTarget,
      slSeconds,
      trend: this.trend(h, now, windowMs),
      risk,
      etaAt: this.etas(store, members, waiting, aht, now),
    };
  }

  // ---------------------------------------------------------------------------

  /** Ritmo dos últimos 5 min comparado ao restante da janela. */
  private trend(h: History, now: number, windowMs: number): QueueForecast['trend'] {
    if (windowMs <= RECENT_MS) return 'stable';
    const recent = h.joins.filter((t) => t >= now - RECENT_MS).length / (RECENT_MS / 60_000);
    const earlierCount = h.joins.filter((t) => t >= now - windowMs && t < now - RECENT_MS).length;
    const earlier = earlierCount / ((windowMs - RECENT_MS) / 60_000);
    if (recent >= 0.4 && recent > earlier * 1.25) return 'up';
    if (earlier >= 0.4 && recent < earlier * 0.75) return 'down';
    return 'stable';
  }

  /**
   * Horário estimado de atendimento de cada chamador: cada atendente fica livre quando
   * termina a chamada atual (tempo médio − o que já falou, com um mínimo) e então pega o
   * próximo da fila. Arredondado em 10 s para não gerar atualização a cada segundo.
   */
  private etas(
    store: ServerStore,
    members: { endpointId: string | null; inCall: boolean; status: string }[],
    waiting: { uniqueid: string }[],
    aht: number | null,
    now: number,
  ): Record<string, number> {
    const out: Record<string, number> = {};
    if (!aht || members.length === 0 || waiting.length === 0) return out;
    const freeAt = members.map((m) => {
      const busy = m.inCall || m.status === 'INUSE' || m.status === 'BUSY';
      if (!busy) return 0;
      const answered = [...store.channels.values()]
        .filter((c) => c.endpointId !== null && c.endpointId === m.endpointId && c.answeredAt)
        .map((c) => c.answeredAt!);
      const elapsed = answered.length ? (now - Math.min(...answered)) / 1000 : 0;
      return Math.max(aht - elapsed, aht * 0.15);
    });
    for (const caller of waiting) {
      freeAt.sort((a, b) => a - b);
      const t = freeAt[0]!;
      out[caller.uniqueid] = Math.round((now + t * 1000) / 10_000) * 10_000;
      freeAt[0] = t + aht;
    }
    return out;
  }

  private of(queue: string): History {
    let h = this.history.get(queue);
    if (!h) {
      h = { joins: [], answers: [] };
      this.history.set(queue, h);
    }
    return h;
  }

  private prune(queue: string, now: number): void {
    const h = this.history.get(queue);
    if (!h) return;
    const limit = now - HISTORY_MS;
    while (h.joins.length && h.joins[0]! < limit) h.joins.shift();
    while (h.answers.length && h.answers[0]!.at < limit) h.answers.shift();
  }
}
