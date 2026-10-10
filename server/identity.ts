import crypto from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { DB, VisitorRow } from './db';
import { nowIso } from './db';

export const VISITOR_COOKIE = 'dmme_visitor';
export const ADMIN_COOKIE = 'dmme_admin';

export type AppEnv = { Variables: { visitor: VisitorRow } };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const isHttps = (c: Context) =>
  new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';

export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * There are no accounts: each browser gets a random visitor cookie, and its
 * chat with Alisa belongs to that cookie. Clearing cookies starts a new chat.
 */
export function visitor(db: DB): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, VISITOR_COOKIE);
    let row = token
      ? (db.prepare('SELECT * FROM visitors WHERE token_hash = ?').get(sha256(token)) as VisitorRow | undefined)
      : undefined;
    if (!row) {
      const fresh = crypto.randomBytes(32).toString('base64url');
      const now = nowIso();
      const { lastInsertRowid } = db
        .prepare('INSERT INTO visitors (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)')
        .run(sha256(fresh), now, now);
      row = db.prepare('SELECT * FROM visitors WHERE id = ?').get(lastInsertRowid) as VisitorRow;
      setCookie(c, VISITOR_COOKIE, fresh, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isHttps(c),
        path: '/',
        maxAge: 400 * 86_400,
      });
    } else if (Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
      db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    c.set('visitor', row);
    await next();
  };
}

// ---- Admin (a single shared password, no accounts) ----------------------------

const ADMIN_DAYS = 30;

function adminSignature(secret: string, exp: number) {
  return crypto.createHmac('sha256', secret).update(`admin\n${exp}`).digest('base64url');
}

export function passwordMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(expected));
  return crypto.timingSafeEqual(a, b);
}

export function grantAdmin(c: Context, secret: string) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_DAYS * 86_400;
  setCookie(c, ADMIN_COOKIE, `${exp}.${adminSignature(secret, exp)}`, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isHttps(c),
    path: '/',
    maxAge: ADMIN_DAYS * 86_400,
  });
}

export function revokeAdmin(c: Context) {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
}

export function isAdmin(c: Context, secret: string, password: string): boolean {
  if (!password) return false;
  const [expStr, sig] = (getCookie(c, ADMIN_COOKIE) ?? '').split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(adminSignature(secret, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
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
