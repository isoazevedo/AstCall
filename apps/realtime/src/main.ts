import { PROTOCOL_VERSION } from '@astcall/shared';
import { AmiConnection } from './ami/index.js';
import { ConfigError, loadConfig, type AppConfig } from './config/index.js';
import { createLogger } from './logger.js';

/**
 * Ponto de entrada do backend de tempo real.
 * Por enquanto: carrega a configuração e mantém uma conexão AMI por servidor.
 * O store, a sincronização e o WebSocket entram nos próximos itens do roadmap.
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

  // Uma conexão AMI por servidor Asterisk
  const connections = config.servers.map((server) => {
    const conn = new AmiConnection(server, log);
    conn.on('event', (ev) => log.debug({ server: server.id, event: ev.event }, 'Evento AMI'));
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
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
