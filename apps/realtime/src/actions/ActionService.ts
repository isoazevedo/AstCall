import { z } from 'zod';
import {
  ACTION_PERMISSION,
  DIAL_TARGET,
  hasPermission,
  type ActionName,
  type ServerId,
  type TokenClaims,
} from '@astcall/shared';
import { AmiActionError, AmiDisconnectedError, type AmiActionFields } from '../ami/index.js';
import type { AmiConnection } from '../ami/AmiConnection.js';
import type { Logger } from '../logger.js';
import type { ServerStore } from '../state/ServerStore.js';
import { ScopeFilter } from '../state/visibility.js';

/** Erro de ação com código estável (a interface traduz) e mensagem segura para o usuário. */
export class ActionError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'invalid'
      | 'not_found'
      | 'not_bridged'
      | 'rate_limited'
      | 'ami_error'
      | 'disconnected'
      | 'unknown_server',
    message: string,
  ) {
    super(message);
  }
}

/** O que o serviço precisa de cada servidor. */
export interface ActionTarget {
  conn: Pick<AmiConnection, 'sendAction' | 'sendListAction'>;
  store: ServerStore;
}

/** Uma action AMI pronta para enviar. */
interface AmiCall {
  action: string;
  fields: AmiActionFields;
}

const dialTarget = z.string().trim().regex(DIAL_TARGET, 'use apenas dígitos, *, # ou +');

/** Parâmetros aceitos por ação (o que vier a mais é descartado). */
const SCHEMAS = {
  queuePause: z.object({
    queue: z.string().min(1).max(128).nullable(),
    interface: z.string().min(1).max(128),
    paused: z.boolean(),
    reason: z.string().trim().max(64).optional(),
  }),
  hangup: z.object({ uniqueid: z.string().min(1).max(64) }),
  transfer: z.object({ uniqueid: z.string().min(1).max(64), to: dialTarget }),
  originate: z.object({ from: z.string().min(1).max(64), to: dialTarget }),
  spy: z.object({
    uniqueid: z.string().min(1).max(64),
    listener: z.string().trim().min(1).max(64),
    mode: z.enum(['listen', 'whisper', 'barge']),
  }),
} satisfies Record<ActionName, z.ZodType>;

/** Tempo de cache do contexto de dialplan de cada endpoint. */
const CONTEXT_TTL_MS = 5 * 60_000;

/**
 * Executa as ações pedidas pelo painel:
 * 1. confere se o usuário tem a permissão da ação NAQUELE servidor;
 * 2. limita a frequência por usuário;
 * 3. valida os parâmetros e confere no estado atual (canal existe? membro existe?);
 * 4. monta e envia a action AMI — o navegador nunca escolhe a action nem nomes de canal;
 * 5. registra tudo no log de auditoria.
 */
export class ActionService {
  private readonly audit: Logger;
  private readonly recent = new Map<string, number[]>();
  private readonly contexts = new Map<string, { context: string; at: number }>();

  constructor(
    private readonly targets: Map<ServerId, ActionTarget>,
    log: Logger,
    private readonly limit = { max: 20, windowMs: 10_000 },
  ) {
    this.audit = log.child({ mod: 'audit' });
  }

  async execute(
    claims: TokenClaims,
    serverId: ServerId,
    name: string,
    params: unknown,
  ): Promise<void> {
    const who = { user: claims.sub, iss: claims.iss, server: serverId, action: name };
    try {
      const calls = await this.prepare(claims, serverId, name, params);
      const target = this.targets.get(serverId)!;
      try {
        for (const call of calls) await target.conn.sendAction(call.action, call.fields);
      } catch (err) {
        if (err instanceof AmiDisconnectedError) {
          throw new ActionError('disconnected', 'servidor Asterisk desconectado');
        }
        if (err instanceof AmiActionError) {
          throw new ActionError('ami_error', err.response.message || 'o Asterisk recusou a ação');
        }
        throw err;
      }
      this.audit.info(
        { ...who, params, ami: calls.map((c) => c.action).join(','), ok: true },
        'Ação executada',
      );
    } catch (err) {
      const code = err instanceof ActionError ? err.code : 'ami_error';
      this.audit.warn(
        { ...who, params, ok: false, code, err: (err as Error).message },
        'Ação recusada',
      );
      if (err instanceof ActionError) throw err;
      throw new ActionError('ami_error', 'falha ao executar a ação');
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Valida tudo e devolve as actions AMI (sem enviar). Separado para facilitar os testes.
   * Normalmente é uma só; "pausar em todas as filas" com escopo vira uma por fila da empresa.
   */
  async prepare(
    claims: TokenClaims,
    serverId: ServerId,
    name: string,
    params: unknown,
  ): Promise<AmiCall[]> {
    if (!(name in SCHEMAS)) throw new ActionError('invalid', `ação desconhecida: ${name}`);
    const action = name as ActionName;
    const target = this.targets.get(serverId);
    if (!target) throw new ActionError('unknown_server', `servidor desconhecido: ${serverId}`);
    if (!hasPermission(claims.perms, serverId, ACTION_PERMISSION[action])) {
      throw new ActionError('forbidden', 'sem permissão para esta ação neste servidor');
    }
    this.checkRate(claims.sub);

    const parsed = SCHEMAS[action].safeParse(params);
    if (!parsed.success) {
      throw new ActionError('invalid', parsed.error.issues[0]?.message ?? 'parâmetros inválidos');
    }

    // Multi-empresa: com escopo, só age no que a empresa enxerga. Fora do escopo a resposta é
    // "não encontrado" (não revela que existe algo de outra empresa).
    const scope = claims.scope?.[serverId];
    const filter = scope ? new ScopeFilter(scope, target.store) : undefined;
    const data = parsed.data as Record<string, unknown>;
    if (filter) {
      const notFound = () => new ActionError('not_found', 'não encontrado');
      if (typeof data.uniqueid === 'string' && !filter.channelIdVisible(data.uniqueid))
        throw notFound();
      if (typeof data.from === 'string' && !filter.endpointVisible(data.from)) throw notFound();
      if (typeof data.listener === 'string' && !filter.endpointVisible(data.listener))
        throw notFound();
      if (typeof data.queue === 'string' && !filter.queueVisible(data.queue)) throw notFound();
    }

    switch (action) {
      case 'queuePause':
        return this.buildQueuePause(target, data as z.infer<typeof SCHEMAS.queuePause>, filter);
      case 'hangup':
        return [this.buildHangup(target, data as z.infer<typeof SCHEMAS.hangup>)];
      case 'transfer':
        return [await this.buildTransfer(target, data as z.infer<typeof SCHEMAS.transfer>)];
      case 'originate':
        return [await this.buildOriginate(target, data as z.infer<typeof SCHEMAS.originate>)];
      case 'spy':
        return [this.buildSpy(target, data as z.infer<typeof SCHEMAS.spy>)];
    }
  }

  private buildQueuePause(
    { store }: ActionTarget,
    p: z.infer<typeof SCHEMAS.queuePause>,
    filter?: ScopeFilter,
  ): AmiCall[] {
    const members = [...store.queueMembers.values()].filter(
      (m) =>
        m.interface === p.interface &&
        (p.queue === null || m.queue === p.queue) &&
        (!filter || filter.queueVisible(m.queue)),
    );
    if (members.length === 0) {
      throw new ActionError('not_found', 'membro não encontrado nesta fila');
    }
    const fields = (queue: string | undefined) => ({
      Interface: p.interface,
      Paused: p.paused ? 'true' : 'false',
      Queue: queue,
      Reason: p.paused && p.reason ? p.reason : undefined,
    });
    // "Todas as filas": sem escopo, uma action sem Queue (o Asterisk aplica em todas);
    // com escopo, uma por fila da empresa — nunca mexe em filas de outra empresa.
    if (p.queue === null && filter) {
      return [...new Set(members.map((m) => m.queue))].map((q) => ({
        action: 'QueuePause',
        fields: fields(q),
      }));
    }
    return [{ action: 'QueuePause', fields: fields(p.queue ?? undefined) }];
  }

  private buildHangup({ store }: ActionTarget, p: z.infer<typeof SCHEMAS.hangup>): AmiCall {
    const ch = store.channels.get(p.uniqueid);
    if (!ch) throw new ActionError('not_found', 'a chamada já terminou');
    return { action: 'Hangup', fields: { Channel: ch.name, Cause: 16 } };
  }

  /**
   * Transferência cega: no AMI, `BlindTransfer` recebe o canal de quem TRANSFERE e leva quem
   * está na bridge com ele para o destino. O painel indica quem deve ser transferido; aqui
   * achamos o outro lado da bridge (o "transferidor") e usamos o contexto do ramal dele.
   */
  private async buildTransfer(
    target: ActionTarget,
    p: z.infer<typeof SCHEMAS.transfer>,
  ): Promise<AmiCall> {
    const { store } = target;
    const ch = store.channels.get(p.uniqueid);
    if (!ch) throw new ActionError('not_found', 'a chamada já terminou');
    const bridge = ch.bridgeId ? store.bridges.get(ch.bridgeId) : undefined;
    const peerId = bridge?.channelIds.find((id) => id !== ch.uniqueid);
    const peer = peerId ? store.channels.get(peerId) : undefined;
    if (!peer)
      throw new ActionError('not_bridged', 'só é possível transferir uma chamada em conversa');
    const context = await this.contextFor(target, peer.endpointId, peer.context);
    return {
      action: 'BlindTransfer',
      fields: { Channel: peer.name, Exten: p.to, Context: context },
    };
  }

  /** Originar: o ramal `from` toca; ao atender, o Asterisk disca `to` no contexto do ramal. */
  private async buildOriginate(
    target: ActionTarget,
    p: z.infer<typeof SCHEMAS.originate>,
  ): Promise<AmiCall> {
    if (!target.store.endpoints.has(p.from)) {
      throw new ActionError('not_found', `ramal ${p.from} não encontrado`);
    }
    const context = await this.contextFor(target, p.from, '');
    return {
      action: 'Originate',
      fields: {
        Channel: `PJSIP/${p.from}`,
        Context: context,
        Exten: p.to,
        Priority: 1,
        // Identificador do próprio ramal: ele segue na discagem, então o destino vê quem liga
        // (usar o número de destino aqui faria o destino ver o próprio número).
        CallerID: `<${p.from}>`,
        Timeout: 30_000,
        Async: 'true',
      },
    };
  }

  /**
   * Escuta: o ramal `listener` (qualquer ramal informado pelo supervisor — pode ser o de um
   * diretor) toca e, ao atender, entra no ChanSpy do canal escolhido.
   * Opções do ChanSpy: q = sem bipe/anúncio; E = sai quando o canal escutado desliga;
   * w = sussurrar (fala só com o escutado); B = intervir (fala com os dois lados).
   */
  private buildSpy({ store }: ActionTarget, p: z.infer<typeof SCHEMAS.spy>): AmiCall {
    const ch = store.channels.get(p.uniqueid);
    if (!ch) throw new ActionError('not_found', 'a chamada já terminou');
    const listener = store.endpoints.get(p.listener);
    if (!listener) throw new ActionError('not_found', `ramal ${p.listener} não encontrado`);
    if (listener.deviceState === 'UNAVAILABLE' || listener.contacts.length === 0) {
      throw new ActionError('invalid', `o ramal ${p.listener} não está registrado`);
    }
    if (ch.endpointId === p.listener) {
      throw new ActionError('invalid', 'o ramal que vai escutar é o próprio ramal da chamada');
    }
    const options = { listen: 'qE', whisper: 'qEw', barge: 'qEB' }[p.mode];
    const who = ch.callerId.num || ch.endpointId || ch.name;
    return {
      action: 'Originate',
      fields: {
        Channel: `PJSIP/${p.listener}`,
        Application: 'ChanSpy',
        // Nome completo do canal: o ChanSpy usa como prefixo, então pega exatamente este canal
        Data: `${ch.name},${options}`,
        // O telefone de quem vai escutar mostra quem será escutado
        CallerID: `"Escuta ${who}" <${who}>`,
        Timeout: 30_000,
        Async: 'true',
      },
    };
  }

  /**
   * Contexto de dialplan de um endpoint, consultado no Asterisk (`PJSIPShowEndpoint`).
   * No AzCall o contexto carrega o tenant (ex.: from-internal-default), então não dá para
   * usar um contexto fixo. Cache de alguns minutos; `fallback` se não for possível descobrir.
   */
  private async contextFor(
    target: ActionTarget,
    endpointId: string | null,
    fallback: string,
  ): Promise<string> {
    if (endpointId) {
      const cached = this.contexts.get(endpointId);
      if (cached && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.context;
      try {
        const res = await target.conn.sendListAction('PJSIPShowEndpoint', { Endpoint: endpointId });
        const detail = res.events.find((e) => e.event === 'EndpointDetail');
        if (detail?.context) {
          this.contexts.set(endpointId, { context: detail.context, at: Date.now() });
          return detail.context;
        }
      } catch {
        // cai no fallback
      }
    }
    if (fallback) return fallback;
    throw new ActionError('invalid', 'não foi possível descobrir o contexto de discagem do ramal');
  }

  private checkRate(user: string): void {
    const now = Date.now();
    const times = (this.recent.get(user) ?? []).filter((t) => now - t < this.limit.windowMs);
    if (times.length >= this.limit.max) {
      throw new ActionError('rate_limited', 'muitas ações em sequência; aguarde alguns segundos');
    }
    times.push(now);
    this.recent.set(user, times);
  }
}
