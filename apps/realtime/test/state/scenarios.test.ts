import { describe, expect, it } from 'vitest';
import { at, linksByName, loadFixture, nth, replay, uid } from '../helpers/replay.js';

/**
 * Cenários gravados no laboratório (Asterisk 20, AzCall) e anonimizados.
 * Cada teste reproduz a gravação e confere o estado em pontos-chave.
 */

const FIXTURES = [
  '01-chamada-atendida.jsonl',
  '02-nao-atendida.jsonl',
  '03-transferencia-cega.jsonl',
  '04-transferencia-assistida.jsonl',
  '05-fila.jsonl',
];

describe('invariantes de todas as gravações de chamada', () => {
  it.each(FIXTURES)('%s termina sem canais, bridges ou chamadas', (name) => {
    const { snapshot } = replay(loadFixture(name));
    expect(snapshot.channels).toEqual([]);
    expect(snapshot.bridges).toEqual([]);
    expect(snapshot.calls).toEqual([]);
    for (const ep of snapshot.endpoints) expect(ep.activeChannels).toBe(0);
  });

  it.each(FIXTURES)('%s é idempotente (cada evento aplicado duas vezes)', (name) => {
    const events = loadFixture(name);
    // Compara o estado em todos os pontos intermediários
    for (let i = 1; i <= events.length; i += 5) {
      const once = replay(events.slice(0, i)).snapshot;
      const twice = replay(events.slice(0, i), { repeat: 2 }).snapshot;
      expect(twice).toEqual(once);
    }
  });

  it.each(FIXTURES)('%s não emite deltas repetidos', (name) => {
    const events = loadFixture(name);
    const { deltas } = replay(events, { repeat: 2 });
    const once = replay(events).deltas;
    expect(deltas).toHaveLength(once.length);
  });
});

describe('cenário 1: chamada atendida (9002 → 9001)', () => {
  const events = loadFixture('01-chamada-atendida.jsonl');

  it('agrupa os dois canais numa chamada em conversa, com gravação', () => {
    const { snapshot } = replay(events, { until: at('BridgeEnter', 'PJSIP/9002') });
    expect(snapshot.calls).toHaveLength(1);
    const call = snapshot.calls[0]!;
    expect(call.channelIds).toHaveLength(2);
    expect(call.status).toBe('talking');
    expect(call.recording).toBe(true);
    expect(call.answeredAt).not.toBeNull();
    expect(linksByName(snapshot, call.id)).toEqual([['PJSIP/9001', 'PJSIP/9002']]);
    expect(snapshot.bridges[0]?.channelIds).toHaveLength(2);
  });

  it('conta canais ativos nos endpoints', () => {
    const { snapshot } = replay(events, { until: at('BridgeEnter', 'PJSIP/9002') });
    const ep = (id: string) => snapshot.endpoints.find((e) => e.id === id);
    expect(ep('9001')).toMatchObject({ deviceState: 'INUSE', activeChannels: 1 });
    expect(ep('9002')).toMatchObject({ deviceState: 'INUSE', activeChannels: 1 });
  });

  it('enquanto toca, a chamada está "ringing" e o destino sabe quem discou', () => {
    const { snapshot } = replay(events, { until: at('DialState') });
    expect(snapshot.calls[0]?.status).toBe('ringing');
    const callee = snapshot.channels.find((c) => c.name.startsWith('PJSIP/9001'));
    expect(callee?.dialedBy).toBe(uid(snapshot, 'PJSIP/9002'));
  });

  it('endpoints voltam a NOT_INUSE no fim', () => {
    const { snapshot } = replay(events);
    expect(snapshot.endpoints.map((e) => e.deviceState)).toEqual(['NOT_INUSE', 'NOT_INUSE']);
  });
});

describe('cenário 2: chamada não atendida', () => {
  const events = loadFixture('02-nao-atendida.jsonl');

  it('nunca cria bridge e registra NOANSWER no originador', () => {
    const { snapshot, deltas } = replay(events, { until: at('DialEnd') });
    expect(deltas.some((d) => d.entity === 'bridge')).toBe(false);
    const caller = snapshot.channels.find((c) => c.name.startsWith('PJSIP/9002'));
    expect(caller?.dialStatus).toBe('NOANSWER');
    expect(snapshot.calls[0]?.answeredAt).toBeNull();
  });
});

describe('cenário 3: transferência cega (9002 ↔ 9001 → 9005)', () => {
  const events = loadFixture('03-transferencia-cega.jsonl');

  it('marca a chamada como em espera durante o Hold', () => {
    const { snapshot } = replay(events, { until: at('Hold') });
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]?.status).toBe('held');
  });

  it('enquanto 9005 toca, a chamada volta a "ringing" com o mesmo Linkedid', () => {
    const before = replay(events, { until: nth(1, at('BridgeEnter', 'PJSIP/9002')) }).snapshot;
    const ringing = replay(events, { until: at('DialState', 'PJSIP/9002') }).snapshot;
    // o primeiro DialState do 9002 nesta gravação é para o 9001; o segundo é para o 9005
    const ringing9005 = replay(events, { until: nth(2, at('DialState', 'PJSIP/9002')) }).snapshot;
    expect(ringing.calls[0]?.status).toBe('ringing');
    expect(ringing9005.calls).toHaveLength(1);
    expect(ringing9005.calls[0]?.status).toBe('ringing');
    expect(ringing9005.calls[0]?.id).toBe(before.calls[0]?.id);
  });

  it('após a transferência continua sendo UMA chamada, agora 9002 ⇄ 9005', () => {
    // 1º BridgeEnter do 9002 = conversa com 9001; 2º = conversa com 9005
    const { snapshot } = replay(events, { until: nth(2, at('BridgeEnter', 'PJSIP/9002')) });
    expect(snapshot.calls).toHaveLength(1);
    const call = snapshot.calls[0]!;
    expect(call.status).toBe('talking');
    expect(linksByName(snapshot, call.id)).toEqual([['PJSIP/9002', 'PJSIP/9005']]);
    expect(snapshot.channels.map((c) => c.name.replace(/-\w+$/, '')).sort()).toEqual([
      'PJSIP/9002',
      'PJSIP/9005',
    ]);
  });
});

describe('cenário 4: transferência assistida (com canais Local)', () => {
  const events = loadFixture('04-transferencia-assistida.jsonl');

  it('na consulta, 9001 fala com 9005 através do par Local e 9002 fica sozinho', () => {
    // 1º BridgeEnter de Local = ";1" com o 9001; 2º = ";2" com o 9005 (consulta completa)
    const consult = replay(events, { until: nth(2, at('BridgeEnter', 'Local/9005')) }).snapshot;
    expect(consult.calls).toHaveLength(1);
    const call = consult.calls[0]!;
    expect(call.status).toBe('held');
    expect(linksByName(consult, call.id)).toEqual([['PJSIP/9001', 'PJSIP/9005']]);
    expect(call.bridgeIds).toHaveLength(3);
  });

  it('após completar, a chamada mostra 9002 ⇄ 9005 atravessando o par Local', () => {
    const { snapshot } = replay(events, { until: at('Hangup', 'PJSIP/9001') });
    expect(snapshot.calls).toHaveLength(1);
    const call = snapshot.calls[0]!;
    expect(call.status).toBe('talking');
    expect(linksByName(snapshot, call.id)).toEqual([['PJSIP/9002', 'PJSIP/9005']]);
    // canais Local existem, mas não são endpoints nem aparecem nos links
    expect(snapshot.channels.filter((c) => c.isLocal)).toHaveLength(2);
    expect(snapshot.endpoints.some((e) => e.id.startsWith('Local'))).toBe(false);
  });
});

describe('cenário 5: chamada em fila', () => {
  const events = loadFixture('05-fila.jsonl');

  it('enquanto o membro toca, a chamada está "ringing"', () => {
    const { snapshot } = replay(events, { until: at('DialState') });
    expect(snapshot.calls[0]?.status).toBe('ringing');
  });

  it('após o atendimento, chamador e membro estão ligados', () => {
    const { snapshot } = replay(events, { until: at('BridgeEnter', 'PJSIP/9002') });
    const call = snapshot.calls[0]!;
    expect(call.status).toBe('talking');
    expect(linksByName(snapshot, call.id)).toEqual([['PJSIP/9001', 'PJSIP/9002']]);
  });
});

describe('cenário 6: registro de ramal', () => {
  const events = loadFixture('06-registro-ramal.jsonl');

  it('ao fechar o softphone o ramal fica sem contatos e UNAVAILABLE', () => {
    const { store } = replay(events, { until: at('ContactStatus') });
    expect(store.endpoints.get('9001')).toMatchObject({
      deviceState: 'UNAVAILABLE',
      contacts: [],
    });
  });

  it('ao reabrir volta a ter contato NonQualified e NOT_INUSE', () => {
    const { store } = replay(events);
    const ep = store.endpoints.get('9001')!;
    expect(ep.deviceState).toBe('NOT_INUSE');
    expect(ep.contacts).toHaveLength(1);
    expect(ep.contacts[0]).toMatchObject({ status: 'NonQualified', rttMs: null });
  });
});
