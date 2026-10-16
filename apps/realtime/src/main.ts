import type { Server } from 'node:http';
import { PROTOCOL_VERSION } from '@astcall/shared';
import { AmiConnection, AmiRecorder } from './ami/index.js';
import { authRoutes, LocalIssuer, TokenVerifier, UserRepository } from './auth/index.js';
import { ConfigError, loadConfig, localAuthEnabled, type AppConfig } from './config/index.js';
import { createHttpServer, type RouteHandler } from './http/server.js';
import { createLogger } from './logger.js';
import { ServerStore } from './state/ServerStore.js';
import { Synchronizer } from './sync/Synchronizer.js';

/**
 * Ponto de entrada do backend de tempo real.
 * Mantém, por servidor Asterisk, uma conexão AMI e o estado sincronizado, e atende as rotas
 * de autenticação do modo standalone. O WebSocket entra no próximo item do roadmap.
 */
async function main(): Promise<void> {
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

  // ---- Autenticação: valida tokens dos emissores configurados; emite no modo standalone
  let users: UserRepository | undefined;
  const routes: Record<string, RouteHandler> = {};
  try {
    const verifier = await TokenVerifier.create(config.auth);
    log.info({ issuers: verifier.issuers }, 'Emissores de token aceitos');
    // (o verifier será usado pelo hub WebSocket no item 5)
    if (localAuthEnabled(config.auth)) {
      users = await UserRepository.open(config.auth.local.usersDbFile);
      const issuer = await LocalIssuer.create(config.auth);
      Object.assign(routes, authRoutes({ users, issuer, config: config.auth, log }));
      if (users.listUsers().length === 0) {
        log.warn(
          'Nenhum usuário cadastrado. Crie um com: npm run user -- add <usuario> --perms all',
        );
      }
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[AstCall] Erro de configuração:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const pruneTimer = setInterval(() => users?.pruneSessions(), 60 * 60_000);

  // ---- Servidor HTTP (rotas de autenticação; o WebSocket usará o mesmo servidor)
  const http: Server = createHttpServer(routes, { trustProxy: config.http.trustProxy, log });
  http.listen(config.http.port, config.http.host, () => {
    log.info({ host: config.http.host, port: config.http.port }, 'Servidor HTTP ouvindo');
  });

  // ---- Uma conexão AMI + um store de estado por servidor Asterisk
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

  // ---- Encerramento limpo (Ctrl+C / systemd): Logoff no AMI, fecha HTTP e banco
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Encerrando...');
    clearInterval(pruneTimer);
    http.close();
    await Promise.allSettled(connections.map((c) => c.stop()));
    await Promise.allSettled(recorders.map((r) => r.close()));
    users?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
