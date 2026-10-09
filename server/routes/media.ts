import { Hono } from 'hono';
import type { Deps } from '../app';
import { mimeFromName, sniffImage } from '../media';

/**
 * Serves photos stored on this server (bundled samples, or uploads when no
 * bucket is configured) through signed, expiring links made by MediaStore.url.
 * With a bucket, browsers load photos from the bucket directly instead.
 */
export function mediaRoutes({ media }: Deps) {
  const app = new Hono();

  app.get('/f', async (c) => {
    const key = c.req.query('k') ?? '';
    const exp = Number(c.req.query('e'));
    if (!media.verify(key, exp, c.req.query('s') ?? '')) return c.json({ error: 'This link has expired.' }, 410);
    const data = await media.read(key);
    if (!data) return c.json({ error: 'File not found.' }, 404);
    const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': sniffImage(data) ?? mimeFromName(key) ?? 'application/octet-stream',
      // Short-lived links are view-once photos: never cache those.
      'Cache-Control': remaining < 300 ? 'no-store' : `private, max-age=${Math.min(remaining, 3600)}`,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  return app;
}
