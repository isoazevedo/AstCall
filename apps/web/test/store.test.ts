import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { listAttr } from '../src/lib/attrs';

/** Conexão falsa: conta quantas foram criadas, iniciadas e paradas. */
const created: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock('../src/lib/MonitorConnection', () => ({
  MonitorConnection: class {
    start = vi.fn();
    stop = vi.fn();
    sendAction = vi.fn(async () => ({ t: 'action_result', reqId: '1', ok: true }));
    resync = vi.fn();
    constructor() {
      created.push(this);
    }
  },
}));

const { useMonitorStore, DEFAULT_OWNER } = await import('../src/stores/monitor');

beforeEach(() => {
  created.length = 0;
  setActivePinia(createPinia());
});

describe('conexão compartilhada entre os elementos da página', () => {
  it('o primeiro elemento abre a conexão; os demais reaproveitam', () => {
    const store = useMonitorStore();
    store.connect('/monitor-ws', '/token');
    store.connect('/monitor-ws', '/token');
    store.connect('/outro-ws', '/outro-token'); // vale a do primeiro
    expect(created).toHaveLength(1);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
  });

  it('só o último elemento a sair fecha a conexão', () => {
    const store = useMonitorStore();
    store.connect('/monitor-ws', '/token');
    store.connect('/monitor-ws', '/token');
    store.disconnect();
    expect(created[0]!.stop).not.toHaveBeenCalled();
    store.disconnect();
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
    // um elemento novo depois disso abre outra conexão
    store.connect('/monitor-ws', '/token');
    expect(created).toHaveLength(2);
  });

  it('desconectar a mais não deixa a contagem negativa', () => {
    const store = useMonitorStore();
    store.disconnect();
    store.connect('/monitor-ws', '/token');
    store.disconnect();
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
  });
});

describe('diálogos e avisos no elemento de onde a ação partiu', () => {
  it('o diálogo guarda o dono; sem dono, usa o padrão', () => {
    const store = useMonitorStore();
    store.openDialog({ kind: 'hangup', uniqueid: 'u1', label: '9001' }, 'w2');
    expect(store.dialog?.owner).toBe('w2');
    store.openDialog({ kind: 'hangup', uniqueid: 'u1', label: '9001' });
    expect(store.dialog?.owner).toBe(DEFAULT_OWNER);
  });

  it('o aviso de sucesso vai para o dono do diálogo', async () => {
    const store = useMonitorStore();
    store.connect('/monitor-ws', '/token');
    store.activeServerId = 'pbx1';
    store.openDialog({ kind: 'hangup', uniqueid: 'u1', label: '9001' }, 'w3');
    await store.act('hangup', { uniqueid: 'u1' }, '9001 desligado');
    expect(store.toasts).toEqual([
      expect.objectContaining({ owner: 'w3', text: '9001 desligado', tone: 'success' }),
    ]);
  });
});

describe('atributos com listas', () => {
  it('separa por vírgula, ignora espaços e itens vazios', () => {
    expect([...listAttr(' suporte-1, vendas-1 ,,')]).toEqual(['suporte-1', 'vendas-1']);
    expect(listAttr('').size).toBe(0);
    expect(listAttr(undefined).size).toBe(0);
  });
});
