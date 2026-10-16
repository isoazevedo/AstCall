import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmiClient } from '../../src/ami/AmiClient.js';
import { AmiActionError, AmiDisconnectedError, AmiTimeoutError } from '../../src/ami/types.js';
import type { AmiMessage } from '../../src/ami/types.js';
import { FakeAmiServer } from '../helpers/fakeAmi.js';

let server: FakeAmiServer;
let client: AmiClient;

beforeEach(async () => {
  server = new FakeAmiServer();
  await server.listen();
  client = new AmiClient({ actionTimeoutMs: 500, listTimeoutMs: 500 });
});

afterEach(async () => {
  client.destroy();
  await server.close();
});

describe('AmiClient', () => {
  it('conecta, lê a saudação e autentica', async () => {
    await client.connect('127.0.0.1', server.port);
    expect(client.protocolVersion).toBe('11.0.0');
    await expect(client.login('user', 'pass')).resolves.toBeUndefined();
    expect(server.received[0]).toMatchObject({ action: 'Login', events: 'on' });
  });

  it('rejeita login com credenciais erradas', async () => {
    await client.connect('127.0.0.1', server.port);
    await expect(client.login('user', 'errada')).rejects.toBeInstanceOf(AmiActionError);
  });

  it('correlaciona respostas pelo ActionID mesmo fora de ordem', async () => {
    // A action "Lenta" responde depois da "Rapida"
    server.on('lenta', (a, socket) => {
      setTimeout(() => {
        socket.write(`Response: Success\r\nActionID: ${a.actionid}\r\nQual: lenta\r\n\r\n`);
      }, 50);
    });
    server.on('rapida', () => [{ Response: 'Success', Qual: 'rapida' }]);
    await client.connect('127.0.0.1', server.port);

    const [lenta, rapida] = await Promise.all([
      client.sendAction('Lenta'),
      client.sendAction('Rapida'),
    ]);
    expect(lenta.qual).toBe('lenta');
    expect(rapida.qual).toBe('rapida');
  });

  it('coleta uma lista até o evento Complete sem emiti-la como evento comum', async () => {
    server.on('coreshowchannels', () => [
      { Response: 'Success', EventList: 'start', Message: 'Channels will follow' },
      { Event: 'CoreShowChannel', Channel: 'PJSIP/1001-00000001', Uniqueid: '1.1' },
      { Event: 'CoreShowChannel', Channel: 'PJSIP/1002-00000002', Uniqueid: '1.2' },
      { Event: 'CoreShowChannelsComplete', EventList: 'Complete', ListItems: '2' },
    ]);
    await client.connect('127.0.0.1', server.port);
    const events: AmiMessage[] = [];
    client.on('event', (e) => events.push(e));

    const list = await client.sendListAction('CoreShowChannels');
    expect(list.events.map((e) => e.uniqueid)).toEqual(['1.1', '1.2']);
    expect(list.complete.listitems).toBe('2');
    expect(events).toEqual([]);
  });

  it('rejeita lista quando a resposta é Error', async () => {
    server.on('confbridgelist', () => [{ Response: 'Error', Message: 'No active conferences.' }]);
    await client.connect('127.0.0.1', server.port);
    await expect(client.sendListAction('ConfbridgeList')).rejects.toThrow(/No active conferences/);
  });

  it('emite eventos assíncronos', async () => {
    await client.connect('127.0.0.1', server.port);
    const got = new Promise<AmiMessage>((resolve) => client.once('event', resolve));
    server.broadcast({ Event: 'Hangup', Uniqueid: '1.1', Cause: '16' });
    expect(await got).toMatchObject({ event: 'Hangup', cause: '16' });
  });

  it('expira actions sem resposta', async () => {
    server.on('muda', () => []);
    await client.connect('127.0.0.1', server.port);
    await expect(client.sendAction('Muda', {}, 50)).rejects.toBeInstanceOf(AmiTimeoutError);
  });

  it('rejeita pendências quando a conexão cai', async () => {
    server.on('muda', () => []);
    await client.connect('127.0.0.1', server.port);
    const pending = client.sendAction('Muda');
    const closed = new Promise((resolve) => client.once('close', resolve));
    server.dropAll();
    await expect(pending).rejects.toBeInstanceOf(AmiDisconnectedError);
    await closed;
    await expect(client.sendAction('Ping')).rejects.toBeInstanceOf(AmiDisconnectedError);
  });

  it('não envia valores com quebra de linha', async () => {
    await client.connect('127.0.0.1', server.port);
    await expect(client.sendAction('Hangup', { Channel: 'x\r\nAction: Command' })).rejects.toThrow(
      /quebras de linha/,
    );
    expect(server.received).toHaveLength(0);
  });

  it('falha ao conectar em porta fechada', async () => {
    const port = server.port;
    await server.close();
    await expect(client.connect('127.0.0.1', port)).rejects.toThrow();
  });
});
