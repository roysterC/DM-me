import crypto from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DB, UserRow } from './db';
import { nowIso } from './db';

export const SESSION_COOKIE = 'dmme_session';
const SESSION_DAYS = 30;

export type AppEnv = { Variables: { user: UserRow } };

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(c: Context, db: DB, userId: number) {
  // Secure cookies only over HTTPS (directly or behind a proxy), so plain-http local runs still work.
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    nowIso(),
    expires.toISOString(),
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    expires,
  });
}

export function destroySession(c: Context, db: DB) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function sessionUser(c: Context, db: DB): UserRow | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowIso()) as UserRow | undefined;
  return row ?? null;
}

export function requireUser(db: DB): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    c.set('user', user);
    await next();
  };
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          // fall through to the rejection below
        }
        if (originHost !== host) return c.json({ error: 'Cross-site request blocked' }, 403);
      }
    }
    await next();
  };
}

/** Small fixed-window rate limiter kept in memory (one server process). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  take(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
