import { z } from 'zod';

/**
 * Esquemas de validação da configuração.
 * Separados do carregamento para facilitar os testes.
 */

/** Variáveis de ambiente lidas do `.env` (ou do ambiente do processo). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8090),

  SERVERS_FILE: z.string().min(1).default('config/servers.json'),

  AUTH_MODE: z.enum(['local', 'external', 'both']).default('local'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

  // Emissor local (modo standalone)
  LOCAL_JWT_ISSUER: z.string().min(1).default('astcall'),
  LOCAL_JWT_PRIVATE_KEY_FILE: z.string().min(1).default('keys/local-private.pem'),
  LOCAL_JWT_PUBLIC_KEY_FILE: z.string().min(1).default('keys/local-public.pem'),
  USERS_DB_FILE: z.string().min(1).default('data/users.sqlite'),

  // Emissor externo (modo integrado com o AzCall)
  EXTERNAL_JWT_ISSUER: z.string().min(1).default('azcall'),
  EXTERNAL_JWT_PUBLIC_KEY_FILE: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Um servidor Asterisk em `config/servers.json` (sem segredos). */
export const serverEntrySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'use apenas letras minúsculas, números, "-" e "_"'),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5038),
  enabled: z.boolean().default(true),
});

export const serversFileSchema = z.object({
  servers: z.array(serverEntrySchema).min(1, 'cadastre ao menos um servidor'),
});

export type ServerEntry = z.infer<typeof serverEntrySchema>;
