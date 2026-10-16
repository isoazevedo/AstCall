import { PROTOCOL_VERSION } from '@astcall/shared';
import { AmiConnection, AmiRecorder } from './ami/index.js';
import { ConfigError, loadConfig, type AppConfig } from './config/index.js';
import { createLogger } from './logger.js';
import { ServerStore } from './state/ServerStore.js';
import { Synchronizer } from './sync/Synchronizer.js';

/**
 * Ponto de entrada do backend de tempo real.
 * Por enquanto: mantém, por servidor, uma conexão AMI, o estado sincronizado e os deltas.
 * O WebSocket entra no próximo item do roadmap.
 */
function main(): void {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[AstCall] Erro de configuração:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.logLevel, config.env === 'development');
  log.info(
    {
      servers: config.servers.map((s) => `${s.id} (${s.host}:${s.port})`),
      authMode: config.auth.mode,
      protocol: PROTOCOL_VERSION,
    },
    'AstCall realtime iniciado',
  );

  // Uma conexão AMI + um store de estado por servidor Asterisk
  const recorders: AmiRecorder[] = [];
  const stores = new Map<string, ServerStore>();
  const syncs = new Map<string, Synchronizer>();
  const connections = config.servers.map((server) => {
    const store = new ServerStore();
    stores.set(server.id, store);

    // A cada conexão, o Synchronizer zera o estado e o reconstrói com as listas do AMI;
    // ele também aplica os eventos ao vivo ao store.
    const conn = new AmiConnection(server, log);
    const sync = new Synchronizer(conn, store, log); // registra-se como onConnected da conexão
    syncs.set(server.id, sync);
    store.on('deltas', (ops) =>
      log.debug(
        { server: server.id, deltas: ops.map((d) => `${d.op} ${d.entity} ${d.id}`) },
        'Estado alterado',
      ),
    );
    if (config.amiRecordDir) {
      const recorder = new AmiRecorder(config.amiRecordDir, conn);
      recorders.push(recorder);
      log.warn({ server: server.id, file: recorder.file }, 'Gravando tráfego AMI (dados reais)');
    }
    conn.start();
    return conn;
  });

  // Encerramento limpo (Ctrl+C / systemd): faz Logoff em todos os servidores
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Encerrando...');
    await Promise.allSettled(connections.map((c) => c.stop()));
    await Promise.allSettled(recorders.map((r) => r.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
