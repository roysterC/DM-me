import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import type { Storage } from './storage';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** Identifies the image type from its first bytes rather than trusting the upload's label. */
export function sniffImage(buf: Uint8Array): ImageMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  const riff = String.fromCharCode(...buf.slice(0, 4));
  const webp = String.fromCharCode(...buf.slice(8, 12));
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return null;
}

export const EXT: Record<ImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function mimeFromName(name: string): ImageMime | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return null;
}

export class MediaError extends Error {}

const HOUR = 3_600_000;
const CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Photos by key. Keys starting with `asset:` are the sample photos bundled
 * with the app; everything else lives in the configured storage (an S3
 * bucket in production). Browsers get time-limited signed links either way.
 */
export class MediaStore {
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;

  constructor(
    readonly storage: Storage,
    private assetsDir: string,
    private secret: string,
  ) {}

  /** Validates an uploaded image and stores it under `prefix/`. */
  async save(prefix: 'uploads' | 'library' | 'stories', data: Uint8Array) {
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new MediaError('That photo is too large (10 MB max).');
    const mime = sniffImage(data);
    if (!mime) throw new MediaError('Only JPEG, PNG, WebP or GIF photos can be sent.');
    const { width, height } = dimensions(data);
    const key = `${prefix}/${crypto.randomBytes(12).toString('hex')}.${EXT[mime]}`;
    await this.storage.put(key, data, mime);
    return { key, mime, width, height };
  }

  async saveFile(prefix: 'uploads' | 'library' | 'stories', file: File) {
    if (file.size > MAX_UPLOAD_BYTES) throw new MediaError('That photo is too large (10 MB max).');
    return this.save(prefix, new Uint8Array(await file.arrayBuffer()));
  }

  async read(key: string): Promise<Uint8Array | null> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    let data: Uint8Array | null;
    if (key.startsWith('asset:')) {
      data = await fs
        .readFile(path.join(this.assetsDir, path.basename(key.slice(6))))
        .then((b) => new Uint8Array(b))
        .catch(() => null);
    } else {
      data = await this.storage.get(key);
    }
    if (data) this.remember(key, data);
    return data;
  }

  private remember(key: string, data: Uint8Array) {
    if (data.byteLength > CACHE_BYTES / 4) return;
    this.cache.set(key, data);
    this.cacheBytes += data.byteLength;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cacheBytes -= v.byteLength;
    }
  }

  async remove(key: string) {
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cacheBytes -= cached.byteLength;
    }
    if (key.startsWith('asset:')) return;
    await this.storage.delete(key);
  }

  /**
   * A link the browser can load. Long-lived links are signed per hour, so the
   * same photo keeps the same URL for an hour and browsers can cache it.
   */
  async url(key: string, kind: 'cacheable' | 'brief' = 'cacheable'): Promise<string> {
    const now = Date.now();
    const signedAt = kind === 'brief' ? new Date(now) : new Date(Math.floor(now / HOUR) * HOUR);
    const expiresAt = new Date(kind === 'brief' ? now + 60_000 : signedAt.getTime() + 2 * HOUR);
    if (!key.startsWith('asset:') && this.storage.presign) return this.storage.presign(key, signedAt, expiresAt);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const q = new URLSearchParams({ k: key, e: String(exp), s: this.sign(key, exp) });
    return `/api/media/f?${q}`;
  }

  /** Checks a link made by `url()` for photos served by this server. */
  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  private sign(key: string, exp: number) {
    return crypto.createHmac('sha256', this.secret).update(`media\n${key}\n${exp}`).digest('base64url');
  }
}

export function dimensions(data: Uint8Array): { width: number | null; height: number | null } {
  try {
    const d = imageSize(data);
    const rotated = (d.orientation ?? 1) >= 5;
    return { width: (rotated ? d.height : d.width) ?? null, height: (rotated ? d.width : d.height) ?? null };
  } catch {
    return { width: null, height: null };
  }
}
