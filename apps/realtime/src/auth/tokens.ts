import { readFileSync } from 'node:fs';
import {
  decodeJwt,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  errors as joseErrors,
  type CryptoKey,
} from 'jose';
import { z } from 'zod';
import { PERMISSIONS, type ServerPermissions, type TokenClaims } from '@astcall/shared';
import { ConfigError, localAuthEnabled, type AuthConfig } from '../config/index.js';

const ALG = 'RS256';
/** Tolerância de relógio entre emissor e backend. */
const CLOCK_TOLERANCE_S = 30;

/** Token inválido, expirado ou de emissor desconhecido. A mensagem é segura para logar. */
export class AuthError extends Error {
  override name = 'AuthError';
}

/** Formato das permissões dentro do token. */
export const permsSchema = z.record(z.string().min(1), z.array(z.enum(PERMISSIONS)));

const claimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().default(''),
  iss: z.string().min(1),
  exp: z.number(),
  iat: z.number(),
  perms: permsSchema,
  scope: z
    .record(
      z.string().min(1),
      z.object({
        endpoints: z.array(z.string().max(64)).max(5000),
        queues: z.array(z.string().max(128)).max(1000),
      }),
    )
    .optional(),
  extension: z.string().max(64).optional(),
});

function readKey(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `Não foi possível ler a ${what} em "${file}".\n` +
        'Dica: gere o par de chaves do modo standalone com "npm run keys:generate".',
    );
  }
}

/**
 * Valida tokens de todos os emissores configurados (AstCall local e/ou AzCall).
 * O emissor é lido do próprio token (`iss`) para escolher a chave pública certa;
 * depois a assinatura, o emissor e a validade são conferidos.
 */
export class TokenVerifier {
  private constructor(private readonly keys: Map<string, CryptoKey>) {}

  static async create(auth: AuthConfig): Promise<TokenVerifier> {
    const keys = new Map<string, CryptoKey>();
    if (localAuthEnabled(auth)) {
      const pem = readKey(auth.local.publicKeyFile, 'chave pública local');
      keys.set(auth.local.issuer, await importSPKI(pem, ALG));
    }
    if (auth.mode !== 'local' && auth.external.publicKeyFile) {
      const pem = readKey(auth.external.publicKeyFile, 'chave pública do emissor externo');
      keys.set(auth.external.issuer, await importSPKI(pem, ALG));
    }
    return new TokenVerifier(keys);
  }

  /** Emissores aceitos. */
  get issuers(): string[] {
    return [...this.keys.keys()];
  }

  async verify(token: string): Promise<TokenClaims> {
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      throw new AuthError('token malformado');
    }
    const key = iss ? this.keys.get(iss) : undefined;
    if (!key) throw new AuthError(`emissor não aceito: ${iss ?? '(nenhum)'}`);

    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: iss,
        algorithms: [ALG],
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const parsed = claimsSchema.safeParse(payload);
      if (!parsed.success) throw new AuthError('claims inválidas no token');
      return parsed.data;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new AuthError('token expirado');
      throw new AuthError('assinatura ou claims inválidas');
    }
  }
}

/** Emite tokens do modo standalone (assinados com a chave privada local). */
export class LocalIssuer {
  private constructor(
    private readonly key: CryptoKey,
    private readonly issuer: string,
    private readonly ttlSeconds: number,
  ) {}

  static async create(auth: AuthConfig): Promise<LocalIssuer> {
    const pem = readKey(auth.local.privateKeyFile, 'chave privada local');
    return new LocalIssuer(await importPKCS8(pem, ALG), auth.local.issuer, auth.ttlSeconds);
  }

  /** Assina um token para o usuário. Retorna o token e a expiração em ms. */
  async issue(user: {
    username: string;
    name: string;
    perms: ServerPermissions;
  }): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.ttlSeconds;
    const token = await new SignJWT({ name: user.name, perms: user.perms })
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setSubject(user.username)
      .setIssuer(this.issuer)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: exp * 1000 };
  }
}
