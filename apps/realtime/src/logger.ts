import { pino, type Logger } from 'pino';

/**
 * Logger estruturado (JSON em produção, legível em desenvolvimento).
 * Cada módulo deve criar um filho com contexto, ex.: logger.child({ server: 'pbx1' }).
 */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    // Nunca registrar segredos, mesmo que apareçam por engano em um objeto logado.
    redact: ['secret', '*.secret', 'password', '*.password', 'token', '*.token'],
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
}

export type { Logger };
