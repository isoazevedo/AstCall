import { PROTOCOL_VERSION } from '@astcall/shared';
import { ConfigError, loadConfig } from './config/index.js';
import { createLogger } from './logger.js';

/**
 * Ponto de entrada do backend de tempo real.
 * Por enquanto apenas carrega e valida a configuração; a conexão AMI,
 * o store e o WebSocket entram nos próximos itens do roadmap.
 */
function main(): void {
  let config;
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
}

main();
