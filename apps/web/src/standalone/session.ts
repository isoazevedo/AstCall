import type { Permission, TokenResponse } from '@astcall/shared';

/**
 * Sessão da SPA standalone: guarda o último token (do login ou do /auth/refresh) e o renova
 * quando está perto de vencer. Usado pela tela de usuários, que chama a API /admin/* com
 * `Authorization: Bearer <token>`.
 *
 * O painel (<ast-monitor>) tem a própria renovação; as duas nunca rodam ao mesmo tempo,
 * porque a SPA mostra ou o painel ou a tela de usuários.
 */

export interface SessionInfo {
  sub: string;
  name: string;
  /** Permissões em todos os servidores (chave "*"). Só para mostrar menus; o backend valida. */
  perms: Permission[];
}

/** Erro de sessão: a SPA volta para o login. */
export class SessionExpiredError extends Error {}

let current: TokenResponse | null = null;

/** Lê o conteúdo do token (sem validar a assinatura: quem valida é o backend). */
export function decodeToken(token: string): SessionInfo {
  try {
    // base64url → bytes → texto UTF-8 (atob sozinho trata os bytes como Latin-1 e quebra acentos)
    const b64 = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    return { sub: p.sub ?? '', name: p.name || p.sub || '', perms: p.perms?.['*'] ?? [] };
  } catch {
    return { sub: '', name: '', perms: [] };
  }
}

/** Guarda o token recebido no login ou no refresh. */
export function setSession(t: TokenResponse | null): void {
  current = t;
}

/** Pede um token novo ao /auth/refresh (cookie de sessão). null = sem sessão. */
export async function refresh(): Promise<TokenResponse | null> {
  const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) return null;
  current = (await res.json()) as TokenResponse;
  return current;
}

/** Token válido por pelo menos mais 1 minuto (renova se preciso). */
async function token(): Promise<string> {
  if (!current || current.expiresAt - Date.now() < 60_000) {
    if (!(await refresh())) throw new SessionExpiredError('sessão expirada');
  }
  return current!.token;
}

/**
 * Chama a API de administração. Erros do backend viram Error com a mensagem dele
 * (já em português); 401 vira SessionExpiredError.
 */
export async function adminApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new SessionExpiredError('sessão expirada');
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(data?.error ?? `erro ${res.status}`);
  return data as T;
}
