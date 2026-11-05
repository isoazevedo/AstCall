import type { Server } from 'node:http';
import { PROTOCOL_VERSION, WS_PATH } from '@astcall/shared';
import { ActionService, type ActionTarget } from './actions/index.js';
import { AmiConnection, AmiRecorder } from './ami/index.js';
import { AuditLog } from './audit/AuditLog.js';
import { QueueForecaster } from './forecast/QueueForecaster.js';
import { HistoryRecorder } from './history/HistoryRecorder.js';
import { QualityMonitor } from './quality/QualityMonitor.js';
import { HistoryStore } from './history/HistoryStore.js';
import {
  adminRoutes,
  authRoutes,
  LocalIssuer,
  TokenVerifier,
  UserRepository,
} from './auth/index.js';
import { ConfigError, loadConfig, localAuthEnabled, type AppConfig } from './config/index.js';
import { createHttpServer, type RouteHandler } from './http/server.js';
import { staticRoutes } from './http/static.js';
import { createLogger } from './logger.js';
import { ServerStore } from './state/ServerStore.js';
import { Synchronizer } from './sync/Synchronizer.js';
import { Hub, ServerFeed } from './ws/index.js';

/**
 * Ponto de entrada do backend de tempo real.
 * Mantém, por servidor Asterisk, uma conexão AMI e o estado sincronizado, e atende as rotas
 * de autenticação do modo standalone e o WebSocket que entrega o estado aos navegadores.
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

  // ---- Auditoria das ações (painel e administração de usuários)
  const auditLog = new AuditLog(config.auditFile, log);
  if (config.auditFile) log.info({ file: config.auditFile }, 'Auditoria das ações em arquivo');

  // ---- Autenticação: valida tokens dos emissores configurados; emite no modo standalone
  let users: UserRepository | undefined;
  let verifier: TokenVerifier;
  const routes: Record<string, RouteHandler> = {};
  try {
    verifier = await TokenVerifier.create(config.auth);
    log.info({ issuers: verifier.issuers }, 'Emissores de token aceitos');
    if (localAuthEnabled(config.auth)) {
      users = await UserRepository.open(config.auth.local.usersDbFile);
      const issuer = await LocalIssuer.create(config.auth);
      Object.assign(routes, authRoutes({ users, issuer, config: config.auth, log }));
      Object.assign(
        routes,
        adminRoutes({
          users,
          verifier,
          localIssuer: config.auth.local.issuer,
          log,
          audit: auditLog,
        }),
      );
      const all = users.listUsers();
      if (all.length === 0) {
        log.warn('Nenhum usuário cadastrado. Crie um com: npm run user add <usuario>');
      } else if (!all.some((u) => u.active && u.perms['*']?.includes('users'))) {
        log.warn(
          'Nenhum usuário pode gerenciar usuários pela tela. Conceda com: npm run user perms <usuario> (responda "all")',
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

  // ---- Histórico (máquina do tempo): estado gravado em SQLite, guardado por N dias
  let history: HistoryStore | undefined;
  const historyRecorders: HistoryRecorder[] = [];
  let historyPruneTimer: NodeJS.Timeout | undefined;
  if (config.history) {
    const { dbFile, days } = config.history;
    try {
      // sem foto há mais de 2 intervalos = o AstCall estava desligado naquele horário
      history = await HistoryStore.open(dbFile, {
        maxGapMs: config.history.checkpointMs * 2 + 60_000,
      });
    } catch (err) {
      // Ex.: Node sem `node:sqlite` (anterior ao 22.5). O painel ao vivo segue funcionando.
      log.error(
        { err: (err as Error).message, node: process.version },
        'Histórico desligado: não foi possível abrir o banco (requer Node 22.5 ou mais novo)',
      );
    }
    if (history) {
      const prune = () => history?.prune(Date.now() - days * 86_400_000);
      prune();
      historyPruneTimer = setInterval(prune, 60 * 60_000);
      log.info({ file: dbFile, days }, 'Histórico do estado ligado');
    }
  }

  // ---- Uma conexão AMI + estado sincronizado + feed WebSocket por servidor Asterisk
  const recorders: AmiRecorder[] = [];
  const forecastTimers: NodeJS.Timeout[] = [];
  const feeds = new Map<string, ServerFeed>();
  const actionTargets = new Map<string, ActionTarget>();
  const connections = config.servers.map((server) => {
    const store = new ServerStore();

    // A cada conexão, o Synchronizer zera o estado e o reconstrói com as listas do AMI;
    // ele também aplica os eventos ao vivo ao store.
    const conn = new AmiConnection(server, log);
    // registra-se como onConnected da conexão
    const sync = new Synchronizer(conn, store, log, {
      queueRefreshMs: config.queueRefreshMs,
      channelReconcileMs: config.channelReconcileMs,
    });
    const feed = new ServerFeed(server.id, server.name, { store, sync, conn });
    feed.trunks = server.trunks ?? [];
    feeds.set(server.id, feed);
    if (history && config.history) {
      historyRecorders.push(
        new HistoryRecorder(server.id, history, { store, sync, conn }, config.history),
      );
    }
    actionTargets.set(server.id, { conn, store });
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
    // Previsão das filas (Erlang C): histórico recente dos eventos + cálculo periódico
    if (config.forecast.intervalMs > 0) {
      const forecaster = new QueueForecaster(config.forecast);
      conn.on('event', (ev) => forecaster.onEvent(ev));
      forecastTimers.push(
        setInterval(() => {
          if (!sync.syncing && conn.status === 'ready') forecaster.update(store);
        }, config.forecast.intervalMs),
      );
    }
    // Qualidade de voz (RTCP): Getvar CHANNEL(rtcp,all) nos canais em conversa
    if (config.quality.intervalMs > 0) {
      const quality = new QualityMonitor({ degradedBelow: config.quality.degradedBelow });
      forecastTimers.push(
        setInterval(() => {
          if (!sync.syncing && conn.status === 'ready') void quality.update(store, conn);
        }, config.quality.intervalMs),
      );
    }
    conn.start();
    return conn;
  });

  // ---- Servidor HTTP: rotas de autenticação + WebSocket (WS_PATH) no mesmo endereço
  // Web Component para o AzCall (e qualquer página que queira embutir o painel)
  Object.assign(routes, staticRoutes(config.staticDir, ['ast-monitor.js']));
  const http: Server = createHttpServer(routes, { trustProxy: config.http.trustProxy, log });
  const actions = new ActionService(actionTargets, log, undefined, auditLog);
  const hub = new Hub(feeds, verifier, log, { actions, history });
  hub.attach(http);
  http.listen(config.http.port, config.http.host, () => {
    log.info(
      { host: config.http.host, port: config.http.port, ws: WS_PATH },
      'Servidor HTTP/WebSocket ouvindo',
    );
  });

  // ---- Encerramento limpo (Ctrl+C / systemd): Logoff no AMI, fecha HTTP e banco
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Encerrando...');
    clearInterval(pruneTimer);
    clearInterval(historyPruneTimer);
    for (const r of historyRecorders) r.close();
    history?.close();
    for (const t of forecastTimers) clearInterval(t);
    hub.close();
    for (const feed of feeds.values()) feed.close();
    http.close();
    await Promise.allSettled(connections.map((c) => c.stop()));
    await Promise.allSettled(recorders.map((r) => r.close()));
    await auditLog.close();
    users?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
