import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { UserDTO } from '../../shared/types';
import { createSession, destroySession, hashPassword, RateLimiter, sessionUser, verifyPassword } from '../auth';
import type { UserRow } from '../db';
import { nowIso } from '../db';
import type { Deps } from '../app';

const USERNAME = /^[a-z0-9._]{3,30}$/;

export function toUserDTO(u: UserRow, admins: Set<string>): UserDTO {
  return { id: u.id, username: u.username, isAdmin: admins.has(u.username.toLowerCase()) };
}

function clientIp(c: Parameters<typeof getConnInfo>[0]): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function authRoutes({ db, config }: Deps) {
  const app = new Hono();
  const attempts = new RateLimiter(10, 10 * 60_000);
  const signups = new RateLimiter(5, 60 * 60_000);

  app.post('/signup', async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as never);
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!USERNAME.test(username)) {
      return c.json({ error: 'Usernames are 3–30 characters: letters, numbers, periods and underscores.' }, 400);
    }
    if (password.length < 8) return c.json({ error: 'Use at least 8 characters for your password.' }, 400);
    if (!signups.take(clientIp(c))) return c.json({ error: 'Too many sign-ups from here. Try again later.' }, 429);
    const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (taken) return c.json({ error: 'That username is taken.' }, 409);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), nowIso());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid) as UserRow;
    createSession(c, db, user.id);
    return c.json({ user: toUserDTO(user, config.adminUsernames) });
  });

  app.post('/login', async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as never);
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!attempts.take(`${clientIp(c)}:${username}`)) {
      return c.json({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      return c.json({ error: 'That username and password don’t match.' }, 401);
    }
    createSession(c, db, user.id);
    return c.json({ user: toUserDTO(user, config.adminUsernames) });
  });

  app.post('/logout', (c) => {
    destroySession(c, db);
    return c.json({ ok: true });
  });

  app.get('/me', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    return c.json({ user: toUserDTO(user, config.adminUsernames) });
  });

  return app;
}
