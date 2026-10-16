import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ZodError } from 'zod';
import { envSchema, serversFileSchema, type Env, type ServerEntry } from './schema.js';

/**
 * Raiz do repositório. Caminhos relativos do `.env` são resolvidos a partir daqui,
 * independentemente da pasta de onde o processo foi iniciado.
 * (src/config → src → realtime → apps → raiz; o mesmo vale para dist/config.)
 */
export const ROOT_DIR = resolve(import.meta.dirname, '../../../..');

/** Configuração de um servidor Asterisk, já com as credenciais do AMI. */
export interface AmiServerConfig extends ServerEntry {
  username: string;
  secret: string;
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  http: { host: string; port: number; trustProxy: boolean };
  servers: AmiServerConfig[];
  /** Pasta de gravação do tráfego AMI (desligado quando indefinido). */
  amiRecordDir: string | undefined;
  auth: AuthConfig;
}

export interface AuthConfig {
  mode: Env['AUTH_MODE'];
  /** Validade do token de acesso. */
  ttlSeconds: number;
  local: {
    issuer: string;
    privateKeyFile: string;
    publicKeyFile: string;
    usersDbFile: string;
    refreshTtlHours: number;
    cookieSecure: boolean;
  };
  external: { issuer: string; publicKeyFile: string | undefined };
}

/** O emissor local (modo standalone) está ativo? */
export function localAuthEnabled(auth: AuthConfig): boolean {
  return auth.mode === 'local' || auth.mode === 'both';
}

/** Erro de configuração com mensagem pronta para exibir ao operador. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Nome da variável de ambiente de uma credencial AMI: pbx-1 → AMI_PBX_1_USERNAME. */
export function amiEnvName(serverId: string, field: 'USERNAME' | 'SECRET'): string {
  return `AMI_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
}

function formatZodError(prefix: string, error: ZodError): string {
  const lines = error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`);
  return `${prefix}\n${lines.join('\n')}`;
}

function resolvePath(rootDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(rootDir, p);
}

/**
 * Monta e valida a configuração a partir das variáveis de ambiente e do arquivo de servidores.
 * Função pura em relação ao ambiente (recebe `rawEnv` e `readFile`) para ser testável.
 */
export function buildConfig(
  rawEnv: Record<string, string | undefined>,
  readFile: (path: string) => string,
  rootDir: string = ROOT_DIR,
): AppConfig {
  const env = parseEnv(rawEnv);

  // Arquivo de servidores
  const serversPath = resolvePath(rootDir, env.SERVERS_FILE);
  let serversJson: unknown;
  try {
    serversJson = JSON.parse(readFile(serversPath));
  } catch (err) {
    throw new ConfigError(
      `Não foi possível ler o arquivo de servidores "${serversPath}": ${(err as Error).message}\n` +
        'Dica: copie config/servers.example.json para config/servers.json.',
    );
  }
  const parsedServers = serversFileSchema.safeParse(serversJson);
  if (!parsedServers.success) {
    throw new ConfigError(
      formatZodError(`Arquivo "${serversPath}" inválido:`, parsedServers.error),
    );
  }

  const ids = new Set<string>();
  const servers: AmiServerConfig[] = [];
  const missing: string[] = [];
  for (const entry of parsedServers.data.servers) {
    if (ids.has(entry.id))
      throw new ConfigError(`Servidor duplicado em "${serversPath}": ${entry.id}`);
    ids.add(entry.id);
    if (!entry.enabled) continue;

    // Credenciais do AMI ficam só no ambiente, nunca no servers.json
    const username = rawEnv[amiEnvName(entry.id, 'USERNAME')];
    const secret = rawEnv[amiEnvName(entry.id, 'SECRET')];
    if (!username) missing.push(amiEnvName(entry.id, 'USERNAME'));
    if (!secret) missing.push(amiEnvName(entry.id, 'SECRET'));
    servers.push({ ...entry, username: username ?? '', secret: secret ?? '' });
  }
  if (missing.length > 0) {
    throw new ConfigError(`Credenciais AMI ausentes no ambiente: ${missing.join(', ')}`);
  }
  if (servers.length === 0) {
    throw new ConfigError(`Nenhum servidor habilitado em "${serversPath}".`);
  }

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    http: { host: env.HTTP_HOST, port: env.HTTP_PORT, trustProxy: env.TRUST_PROXY },
    servers,
    amiRecordDir: env.AMI_RECORD_DIR ? resolvePath(rootDir, env.AMI_RECORD_DIR) : undefined,
    auth: buildAuth(env, rootDir),
  };
}

function parseEnv(rawEnv: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    throw new ConfigError(formatZodError('Variáveis de ambiente inválidas:', parsed.error));
  }
  return parsed.data;
}

function buildAuth(env: Env, rootDir: string): AuthConfig {
  // Modo integrado exige a chave pública do AzCall
  if (env.AUTH_MODE !== 'local' && !env.EXTERNAL_JWT_PUBLIC_KEY_FILE) {
    throw new ConfigError(
      `AUTH_MODE=${env.AUTH_MODE} exige EXTERNAL_JWT_PUBLIC_KEY_FILE (chave pública do emissor externo).`,
    );
  }
  return {
    mode: env.AUTH_MODE,
    ttlSeconds: env.JWT_TTL_SECONDS,
    local: {
      issuer: env.LOCAL_JWT_ISSUER,
      privateKeyFile: resolvePath(rootDir, env.LOCAL_JWT_PRIVATE_KEY_FILE),
      publicKeyFile: resolvePath(rootDir, env.LOCAL_JWT_PUBLIC_KEY_FILE),
      usersDbFile: resolvePath(rootDir, env.USERS_DB_FILE),
      refreshTtlHours: env.REFRESH_TTL_HOURS,
      cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    },
    external: {
      issuer: env.EXTERNAL_JWT_ISSUER,
      publicKeyFile: env.EXTERNAL_JWT_PUBLIC_KEY_FILE
        ? resolvePath(rootDir, env.EXTERNAL_JWT_PUBLIC_KEY_FILE)
        : undefined,
    },
  };
}

/** Carrega o `.env` da raiz, se existir. Variáveis já definidas no ambiente têm precedência. */
function loadDotEnv(): void {
  const envFile = resolve(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Carrega o `.env` e devolve a configuração validada. */
export function loadConfig(): AppConfig {
  loadDotEnv();
  return buildConfig(process.env, (p) => readFileSync(p, 'utf8'));
}

/** Só a configuração de autenticação (para os scripts de usuários e chaves, sem exigir o AMI). */
export function loadAuthConfig(): AuthConfig {
  loadDotEnv();
  return buildAuth(parseEnv(process.env), ROOT_DIR);
}
