import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerPermissions, TokenClaims } from '@astcall/shared';
import { ActionError, ActionService, type ActionTarget } from '../../src/actions/index.js';
import { AmiActionError, AmiDisconnectedError } from '../../src/ami/types.js';
import type { AmiActionFields, AmiListResult, AmiMessage } from '../../src/ami/types.js';
import { applyEvent } from '../../src/handlers/index.js';
import { createLogger } from '../../src/logger.js';
import { ServerStore } from '../../src/state/ServerStore.js';
import { at, loadFixture, replay } from '../helpers/replay.js';

const log = createLogger('silent', false);

/** AMI falso: registra as actions e responde o PJSIPShowEndpoint com um contexto. */
class FakeConn {
  sent: { action: string; fields: AmiActionFields }[] = [];
  contexts: Record<string, string> = {
    '9001': 'from-internal-default',
    '9002': 'from-internal-default',
  };
  fail: Error | undefined;

  async sendAction(action: string, fields: AmiActionFields = {}): Promise<AmiMessage> {
    if (this.fail) throw this.fail;
    this.sent.push({ action, fields });
    return { response: 'Success' };
  }

  async sendListAction(action: string, fields: AmiActionFields = {}): Promise<AmiListResult> {
    const ep = String(fields.Endpoint);
    const ctx = this.contexts[ep];
    if (action !== 'PJSIPShowEndpoint' || !ctx) {
      throw new AmiActionError(action, {
        response: 'Error',
        message: 'Unable to retrieve endpoint',
      });
    }
    const events = [{ event: 'EndpointDetail', objectname: ep, context: ctx }];
    return {
      response: { response: 'Success' },
      events,
      complete: { event: 'EndpointDetailComplete' },
    };
  }
}

const claims = (perms: ServerPermissions, sub = 'ana'): TokenClaims => ({
  sub,
  name: 'Ana',
  iss: 'astcall',
  iat: 0,
  exp: 0,
  perms,
});

const ALL: ServerPermissions = { pbx1: ['view', 'hangup', 'transfer', 'originate', 'queue'] };

let store: ServerStore;
let conn: FakeConn;
let service: ActionService;

beforeEach(() => {
  // Estado real: chamada 9002 ⇄ 9001 em conversa (fixture 1) + endpoints e um membro de fila
  store = replay(loadFixture('01-chamada-atendida.jsonl'), {
    until: at('BridgeEnter', 'PJSIP/9002'),
  }).store;
  applyEvent(store, {
    event: 'QueueMemberStatus',
    queue: 'suporte-default',
    interface: 'PJSIP/9001',
    status: '1',
    paused: '0',
  });
  applyEvent(store, {
    event: 'QueueMemberStatus',
    queue: 'marcacao-default',
    interface: 'PJSIP/9001',
    status: '1',
    paused: '0',
  });
  conn = new FakeConn();
  const targets = new Map<string, ActionTarget>([
    ['pbx1', { conn, store } as unknown as ActionTarget],
  ]);
  service = new ActionService(targets, log, { max: 3, windowMs: 60_000 });
});

const uid = (prefix: string) =>
  [...store.channels.values()].find((c) => c.name.startsWith(prefix))!.uniqueid;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ActionError ? err.code : `outro: ${(err as Error).message}`;
  }
};

describe('permissões e validação', () => {
  it('recusa sem a permissão da ação (e sem permissão no servidor)', async () => {
    expect(
      await code(service.execute(claims({ pbx1: ['view'] }), 'pbx1', 'hangup', { uniqueid: 'x' })),
    ).toBe('forbidden');
    expect(
      await code(
        service.execute(claims({ pbx2: ['hangup'] }), 'pbx1', 'hangup', { uniqueid: 'x' }),
      ),
    ).toBe('forbidden');
    expect(conn.sent).toHaveLength(0);
  });

  it('o curinga "*" concede a permissão em qualquer servidor', async () => {
    const r = await code(
      service.execute(claims({ '*': ['hangup'] }), 'pbx1', 'hangup', {
        uniqueid: uid('PJSIP/9001'),
      }),
    );
    expect(r).toBe('ok');
  });

  it('recusa ação desconhecida, servidor desconhecido e parâmetros inválidos', async () => {
    expect(await code(service.execute(claims(ALL), 'pbx1', 'command', {}))).toBe('invalid');
    expect(await code(service.execute(claims(ALL), 'pbx9', 'hangup', { uniqueid: 'x' }))).toBe(
      'unknown_server',
    );
    // tentativa de injeção no destino
    expect(
      await code(
        service.execute(claims(ALL), 'pbx1', 'originate', {
          from: '9001',
          to: '9002\r\nAction: Command',
        }),
      ),
    ).toBe('invalid');
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'transfer', { uniqueid: 'x', to: 'abc' })),
    ).toBe('invalid');
    expect(conn.sent).toHaveLength(0);
  });

  it('limita a frequência por usuário', async () => {
    const run = () =>
      code(service.execute(claims(ALL), 'pbx1', 'hangup', { uniqueid: 'inexistente' }));
    await run();
    await run();
    await run();
    expect(await run()).toBe('rate_limited');
    // outro usuário não é afetado
    expect(
      await code(
        service.execute(claims(ALL, 'bia'), 'pbx1', 'hangup', { uniqueid: 'inexistente' }),
      ),
    ).toBe('not_found');
  });
});

describe('montagem das actions AMI', () => {
  it('queuePause nesta fila, com motivo', async () => {
    await service.execute(claims(ALL), 'pbx1', 'queuePause', {
      queue: 'suporte-default',
      interface: 'PJSIP/9001',
      paused: true,
      reason: 'Almoço',
    });
    expect(conn.sent[0]).toEqual({
      action: 'QueuePause',
      fields: {
        Interface: 'PJSIP/9001',
        Paused: 'true',
        Queue: 'suporte-default',
        Reason: 'Almoço',
      },
    });
  });

  it('queuePause em todas as filas (sem Queue) e retomar sem motivo', async () => {
    await service.execute(claims(ALL), 'pbx1', 'queuePause', {
      queue: null,
      interface: 'PJSIP/9001',
      paused: false,
      reason: 'ignorado',
    });
    expect(conn.sent[0]?.fields).toEqual({
      Interface: 'PJSIP/9001',
      Paused: 'false',
      Queue: undefined,
      Reason: undefined,
    });
  });

  it('queuePause de membro inexistente', async () => {
    const r = await code(
      service.execute(claims(ALL), 'pbx1', 'queuePause', {
        queue: 'suporte-default',
        interface: 'PJSIP/9999',
        paused: true,
      }),
    );
    expect(r).toBe('not_found');
  });

  it('hangup usa o nome do canal do estado (o navegador só manda o uniqueid)', async () => {
    await service.execute(claims(ALL), 'pbx1', 'hangup', { uniqueid: uid('PJSIP/9001') });
    expect(conn.sent[0]?.action).toBe('Hangup');
    expect(String(conn.sent[0]?.fields.Channel)).toMatch(/^PJSIP\/9001-/);
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'hangup', { uniqueid: 'nao-existe' })),
    ).toBe('not_found');
  });

  it('transfer: transfere o participante pedido usando o canal do outro lado e o contexto dele', async () => {
    // Transferir o 9002 para 9005: quem "transfere" é o 9001 (o outro lado da bridge)
    await service.execute(claims(ALL), 'pbx1', 'transfer', {
      uniqueid: uid('PJSIP/9002'),
      to: '9005',
    });
    expect(conn.sent[0]?.action).toBe('BlindTransfer');
    expect(String(conn.sent[0]?.fields.Channel)).toMatch(/^PJSIP\/9001-/);
    expect(conn.sent[0]?.fields).toMatchObject({ Exten: '9005', Context: 'from-internal-default' });
  });

  it('transfer de chamada que não está em conversa', async () => {
    const ringing = replay(loadFixture('01-chamada-atendida.jsonl'), {
      until: at('DialState'),
    }).store;
    const svc = new ActionService(
      new Map([['pbx1', { conn, store: ringing } as unknown as ActionTarget]]),
      log,
    );
    const caller = [...ringing.channels.values()].find((c) => c.name.startsWith('PJSIP/9002'))!;
    expect(
      await code(
        svc.execute(claims(ALL), 'pbx1', 'transfer', { uniqueid: caller.uniqueid, to: '9005' }),
      ),
    ).toBe('not_bridged');
  });

  it('originate usa o contexto do ramal consultado no Asterisk', async () => {
    await service.execute(claims(ALL), 'pbx1', 'originate', { from: '9001', to: '*600' });
    expect(conn.sent[0]).toMatchObject({
      action: 'Originate',
      fields: {
        Channel: 'PJSIP/9001',
        Context: 'from-internal-default',
        Exten: '*600',
        Priority: 1,
        Async: 'true',
        // identificador do ramal de origem (o destino vê quem liga)
        CallerID: '<9001>',
      },
    });
  });

  it('originate de ramal inexistente ou sem contexto descobrível', async () => {
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'originate', { from: '7777', to: '9002' })),
    ).toBe('not_found');
    delete conn.contexts['9002'];
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'originate', { from: '9002', to: '9001' })),
    ).toBe('invalid');
  });
});

describe('erros do AMI', () => {
  it('traduz recusa do Asterisk e desconexão', async () => {
    conn.fail = new AmiActionError('Hangup', { response: 'Error', message: 'No such channel' });
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'hangup', { uniqueid: uid('PJSIP/9001') })),
    ).toBe('ami_error');
    conn.fail = new AmiDisconnectedError('Hangup');
    expect(
      await code(service.execute(claims(ALL), 'pbx1', 'hangup', { uniqueid: uid('PJSIP/9001') })),
    ).toBe('disconnected');
  });
});

describe('escuta (spy)', () => {
  const SPY: ServerPermissions = { pbx1: ['view', 'spy'] };

  beforeEach(() => {
    // 9005 registrado e livre (o ramal do "diretor" que vai escutar)
    applyEvent(store, { event: 'DeviceStateChange', device: 'PJSIP/9005', state: 'NOT_INUSE' });
    applyEvent(store, {
      event: 'ContactStatus',
      endpointname: '9005',
      aor: '9005',
      uri: 'sip:9005@192.0.2.9:5060',
      contactstatus: 'NonQualified',
    });
  });

  it.each([
    ['listen', 'qE'],
    ['whisper', 'qEw'],
    ['barge', 'qEB'],
  ] as const)('modo %s → ChanSpy com opções %s no ramal informado', async (mode, options) => {
    const target = uid('PJSIP/9002');
    await service.execute(claims(SPY), 'pbx1', 'spy', { uniqueid: target, listener: '9005', mode });
    const sent = conn.sent[0]!;
    expect(sent.action).toBe('Originate');
    expect(sent.fields).toMatchObject({
      Channel: 'PJSIP/9005',
      Application: 'ChanSpy',
      Async: 'true',
    });
    expect(String(sent.fields.Data)).toMatch(new RegExp(`^PJSIP/9002-[0-9a-f]+,${options}$`));
  });

  it('exige permissão spy', async () => {
    const r = await code(
      service.execute(claims({ pbx1: ['view', 'hangup'] }), 'pbx1', 'spy', {
        uniqueid: uid('PJSIP/9002'),
        listener: '9005',
        mode: 'listen',
      }),
    );
    expect(r).toBe('forbidden');
  });

  it('recusa ramal inexistente, sem registro ou o próprio ramal da chamada', async () => {
    const target = uid('PJSIP/9002');
    const run = (listener: string) =>
      code(
        service.execute(claims(SPY), 'pbx1', 'spy', { uniqueid: target, listener, mode: 'listen' }),
      );
    expect(await run('7777')).toBe('not_found');
    expect(await run('9001')).toBe('invalid'); // 9001 existe, mas sem contato registrado na fixture
    applyEvent(store, {
      event: 'ContactStatus',
      endpointname: '9002',
      aor: '9002',
      uri: 'sip:9002@192.0.2.2:5060',
      contactstatus: 'NonQualified',
    });
    expect(await run('9002')).toBe('invalid'); // escutar a si mesmo
    expect(conn.sent).toHaveLength(0);
  });
});

describe('escopo multi-empresa nas ações', () => {
  const scoped = (endpoints: string[], queues: string[]): TokenClaims => ({
    ...claims(ALL),
    scope: { pbx1: { endpoints, queues } },
  });

  it('não age em chamada de outra empresa (responde "não encontrado")', async () => {
    const outra = scoped(['9005'], []);
    expect(
      await code(service.execute(outra, 'pbx1', 'hangup', { uniqueid: uid('PJSIP/9001') })),
    ).toBe('not_found');
    expect(
      await code(service.execute(outra, 'pbx1', 'originate', { from: '9001', to: '9002' })),
    ).toBe('not_found');
    // a empresa dona do 9001 pode
    expect(
      await code(
        service.execute(scoped(['9001'], []), 'pbx1', 'hangup', { uniqueid: uid('PJSIP/9002') }),
      ),
    ).toBe('ok');
  });

  it('"pausar em todas" com escopo vira uma pausa por fila da empresa', async () => {
    await service.execute(scoped(['9001'], ['suporte-default']), 'pbx1', 'queuePause', {
      queue: null,
      interface: 'PJSIP/9001',
      paused: true,
    });
    expect(conn.sent.map((c) => c.fields.Queue)).toEqual(['suporte-default']); // marcacao não
  });

  it('pausa em fila de outra empresa é recusada', async () => {
    const r = await code(
      service.execute(scoped(['9001'], ['suporte-default']), 'pbx1', 'queuePause', {
        queue: 'marcacao-default',
        interface: 'PJSIP/9001',
        paused: true,
      }),
    );
    expect(r).toBe('not_found');
  });
});
