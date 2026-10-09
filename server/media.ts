import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const EXT: Record<ImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Media files live in two places: uploads under the data directory, and the
 * bundled sample photos (Nova's camera roll and default stories), stored as
 * `asset:<name>`.
 */
export class MediaStore {
  private tokens = new Map<string, { file: string; mime: string; expiresAt: number }>();
  readonly uploadsDir: string;

  constructor(
    dataDir: string,
    private assetsDir: string,
  ) {
    this.uploadsDir = dataDir === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'dmme-')) : path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
  }

  async saveUpload(file: File): Promise<{ name: string; mime: ImageMime }> {
    if (file.size > MAX_UPLOAD_BYTES) throw new MediaError('That photo is too large (10 MB max).');
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImage(buf);
    if (!mime) throw new MediaError('Only JPEG, PNG, WebP or GIF photos can be sent.');
    const name = `${crypto.randomBytes(16).toString('hex')}.${EXT[mime]}`;
    fs.writeFileSync(path.join(this.uploadsDir, name), buf);
    return { name, mime };
  }

  resolve(ref: string): string {
    if (ref.startsWith('asset:')) return path.join(this.assetsDir, path.basename(ref.slice(6)));
    return path.join(this.uploadsDir, path.basename(ref));
  }

  exists(ref: string): boolean {
    return fs.existsSync(this.resolve(ref));
  }

  read(ref: string): Buffer | null {
    try {
      return fs.readFileSync(this.resolve(ref));
    } catch {
      return null;
    }
  }

  /** Deletes an uploaded file. Bundled assets are never deleted. */
  remove(ref: string) {
    if (ref.startsWith('asset:')) return;
    fs.rmSync(this.resolve(ref), { force: true });
  }

  /** A single-use link that stops working after `ttlMs`. */
  issueToken(file: string, mime: string, ttlMs = 60_000): string {
    const now = Date.now();
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k);
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, { file, mime, expiresAt: now + ttlMs });
    return token;
  }

  redeemToken(token: string): { file: string; mime: string } | null {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
  }
}

export class MediaError extends Error {}
