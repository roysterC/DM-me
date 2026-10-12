import crypto from 'node:crypto';
import net from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { DB, VisitorRow } from './db';
import { nowIso } from './db';

export const VISITOR_COOKIE = 'dmme_visitor';
export const ADMIN_COOKIE = 'dmme_admin';
/** How long the visitor cookie lasts after the latest visit (400 days is the most browsers allow). */
export const VISITOR_COOKIE_DAYS = 400;

export type AppEnv = { Variables: { visitor: VisitorRow } };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ---- Who's asking, behind a reverse proxy --------------------------------------

/** "::ffff:127.0.0.1" (IPv4 on a dual-stack socket) → "127.0.0.1"; anything that isn't an IP → null. */
function normalizeIp(raw: string | undefined): string | null {
  const ip = raw?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return ip && net.isIP(ip) ? ip : null;
}

/**
 * Which connections may tell us the visitor's address and scheme (X-Forwarded-For and friends).
 * Anyone can send those headers, so they only count from a proxy we trust; otherwise rate limits
 * per IP address could be dodged by making up a new address for each request. Set by TRUST_PROXY:
 * "loopback" (the default: a proxy on this machine, like Caddy in deploy/), "off", or a
 * comma-separated list of addresses and ranges such as "loopback,172.16.0.0/12".
 */
export class ProxyTrust {
  private list = new net.BlockList();

  constructor(spec = 'loopback') {
    for (const entry of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (entry === 'off') continue;
      if (entry === 'loopback') {
        this.list.addSubnet('127.0.0.0', 8, 'ipv4');
        this.list.addAddress('::1', 'ipv6');
        continue;
      }
      const [address, bits] = entry.split('/');
      const type = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
      const max = type === 'ipv4' ? 32 : 128;
      if (!type || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))) {
        throw new Error(`TRUST_PROXY: "${entry}" isn't an IP address or range (like 10.0.0.0/8), "loopback" or "off".`);
      }
      if (bits === undefined) this.list.addAddress(address, type);
      else this.list.addSubnet(address, Number(bits), type);
    }
  }

  trusts(ip: string | null): boolean {
    return !!ip && this.list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
  }
}

export interface ClientInfo {
  /** The visitor's address: the connection's, or the one a trusted proxy says it forwarded for. */
  ip: string;
  https: boolean;
  /** The host the visitor asked for. */
  host: string | undefined;
}

declare module 'hono' {
  interface ContextVariableMap {
    client: ClientInfo;
  }
}

export function resolveClient(c: Context, trust: ProxyTrust): ClientInfo {
  let peer: string | null = null;
  try {
    peer = normalizeIp(getConnInfo(c).remote.address);
  } catch {
    // no socket (tests): treat as an unknown, untrusted connection
  }
  const viaProxy = trust.trusts(peer);
  let ip = peer ?? 'unknown';
  if (viaProxy) {
    // Each proxy appends the address it heard from, so read right to left and stop at the first
    // one that isn't a proxy of ours: everything left of it was written by the client.
    const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map(normalizeIp);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i];
      if (!hop) break;
      ip = hop;
      if (!trust.trusts(hop)) break;
    }
  }
  return {
    ip,
    https: new URL(c.req.url).protocol === 'https:' || (viaProxy && c.req.header('x-forwarded-proto') === 'https'),
    host: (viaProxy && c.req.header('x-forwarded-host')) || c.req.header('host'),
  };
}

/** Works out who's asking once per request; read it with clientIp() and friends. */
export function clientInfo(trust: ProxyTrust): MiddlewareHandler {
  return async (c, next) => {
    c.set('client', resolveClient(c, trust));
    await next();
  };
}

const client = (c: Context) => c.get('client') ?? resolveClient(c, new ProxyTrust());
export const clientIp = (c: Context) => client(c).ip;
export const clientHost = (c: Context) => client(c).host;
export const isHttps = (c: Context) => client(c).https;

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
    const remember = (value: string) =>
      setCookie(c, VISITOR_COOKIE, value, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isHttps(c),
        path: '/',
        maxAge: VISITOR_COOKIE_DAYS * 86_400,
      });
    if (!row) {
      const fresh = crypto.randomBytes(32).toString('base64url');
      const now = nowIso();
      const { lastInsertRowid } = db
        .prepare('INSERT INTO visitors (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)')
        .run(sha256(fresh), now, now);
      row = db.prepare('SELECT * FROM visitors WHERE id = ?').get(lastInsertRowid) as VisitorRow;
      remember(fresh);
    } else if (Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
      // At most hourly: note the visit and renew the cookie, so a regular never loses their chat.
      // Once a visitor stays away past the cookie's lifetime, cleanup removes their chat.
      db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
      remember(token!);
    }
    c.set('visitor', row);
    await next();
  };
}

// ---- Admin (a single shared password, no accounts) ----------------------------

const ADMIN_DAYS = 30;

/**
 * Signs the admin cookie over the password too, so changing ADMIN_PASSWORD signs every browser
 * out, including any that should no longer have access.
 */
function adminSignature(secret: string, password: string, exp: number) {
  return crypto.createHmac('sha256', secret).update(`admin\n${sha256(password)}\n${exp}`).digest('base64url');
}

export function passwordMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(expected));
  return crypto.timingSafeEqual(a, b);
}

export function grantAdmin(c: Context, secret: string, password: string) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_DAYS * 86_400;
  setCookie(c, ADMIN_COOKIE, `${exp}.${adminSignature(secret, password, exp)}`, {
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
  const expected = Buffer.from(adminSignature(secret, password, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        const host = client(c).host;
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

/** One limit for everything a visitor sends (texts, photos, story replies), per visitor and per IP address. */
export class SendLimiter {
  private perVisitor = new RateLimiter(60, 60_000);
  private perIp = new RateLimiter(150, 60_000);

  take(c: Context, visitorId: number): boolean {
    return this.perVisitor.take(`v${visitorId}`) && this.perIp.take(clientIp(c));
  }
}

export const SENDING_TOO_FAST = 'You’re sending messages too fast.';
