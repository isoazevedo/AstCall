import { describe, expect, it } from 'vitest';
import { AmiParser, serializeAction } from '../../src/ami/AmiParser.js';

const GREETING = 'Asterisk Call Manager/11.0.0\r\n';

// Captura (resumida) de um evento real do Asterisk 22
const NEWCHANNEL =
  'Event: Newchannel\r\nPrivilege: call,all\r\nChannel: PJSIP/1001-00000001\r\n' +
  'ChannelState: 0\r\nChannelStateDesc: Down\r\nCallerIDNum: 1001\r\nCallerIDName: Ana Souza\r\n' +
  'Uniqueid: 1760620000.1\r\nLinkedid: 1760620000.1\r\n\r\n';

describe('AmiParser', () => {
  it('lê a saudação e a versão do protocolo', () => {
    const p = new AmiParser();
    expect(p.feed(GREETING)).toEqual([]);
    expect(p.greeting).toBe('11.0.0');
  });

  it('normaliza as chaves para minúsculas', () => {
    const p = new AmiParser();
    const [msg] = p.feed(GREETING + NEWCHANNEL);
    expect(msg).toMatchObject({
      event: 'Newchannel',
      channel: 'PJSIP/1001-00000001',
      calleridname: 'Ana Souza',
      uniqueid: '1760620000.1',
    });
  });

  it('remonta mensagens que chegam em pedaços', () => {
    const p = new AmiParser();
    const data = GREETING + NEWCHANNEL + NEWCHANNEL;
    const out = [];
    for (let i = 0; i < data.length; i += 7) out.push(...p.feed(data.slice(i, i + 7)));
    expect(out).toHaveLength(2);
    expect(out[1]?.linkedid).toBe('1760620000.1');
  });

  it('preserva ":" dentro do valor e une cabeçalhos repetidos', () => {
    const p = new AmiParser();
    const [msg] = p.feed(
      GREETING + 'Response: Follows\r\nOutput: linha: 1\r\nOutput: linha 2\r\n\r\n',
    );
    expect(msg?.output).toBe('linha: 1\nlinha 2');
  });

  it('reset() volta a esperar a saudação', () => {
    const p = new AmiParser();
    p.feed(GREETING + 'Event: Parcial\r\n');
    p.reset();
    expect(p.greeting).toBeUndefined();
    expect(p.feed(GREETING + NEWCHANNEL)).toHaveLength(1);
  });
});

describe('serializeAction', () => {
  it('gera o pacote com cabeçalhos repetidos para arrays', () => {
    expect(serializeAction({ Action: 'Originate', Variable: ['A=1', 'B=2'] })).toBe(
      'Action: Originate\r\nVariable: A=1\r\nVariable: B=2\r\n\r\n',
    );
  });

  it('bloqueia quebras de linha (injeção de cabeçalhos/actions)', () => {
    expect(() =>
      serializeAction({ Action: 'Hangup', Channel: 'PJSIP/1001\r\n\r\nAction: Command' }),
    ).toThrow(/quebras de linha/);
  });
});
