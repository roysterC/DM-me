import type { LibraryPhotoDTO } from '../shared/types';
import { SAMPLE_PHOTOS, type RollEntry } from './ai/nova';
import type { Responder } from './ai/responder';
import type { DB, LibraryPhotoRow } from './db';
import { nowIso } from './db';
import { dimensions, type MediaStore, sniffImage } from './media';

/** How many photos Nova is told about per reply; the newest win when the roll is bigger. */
export const ROLL_LIMIT = 150;
const SYNC_BATCH = 40;

export const photoRef = (id: number) => `p${id}`;
export const refToId = (ref: string) => Number(ref.slice(1));

export function seedLibrary(db: DB, enabled: boolean) {
  if (!enabled) return;
  const count = (db.prepare('SELECT COUNT(*) n FROM library_photos').get() as { n: number }).n; // hidden rows count too
  if (count > 0) return;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO library_photos (media_key, media_mime, width, height, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const dims: Record<string, [number, number]> = {
    'asset:skillet.jpg': [800, 666],
    'asset:coffee.jpg': [780, 1380],
    'asset:steak.jpg': [780, 1380],
    'asset:mountain.jpg': [780, 1380],
  };
  for (const p of SAMPLE_PHOTOS) insert.run(p.key, 'image/jpeg', ...(dims[p.key] ?? [null, null]), p.description, nowIso());
}

export function listLibrary(db: DB, limit = 1000): LibraryPhotoRow[] {
  return db.prepare('SELECT * FROM library_photos WHERE hidden = 0 ORDER BY id DESC LIMIT ?').all(limit) as LibraryPhotoRow[];
}

export function cameraRoll(db: DB): { roll: RollEntry[]; byRef: Map<string, LibraryPhotoRow>; refByKey: Map<string, string> } {
  const rows = listLibrary(db, ROLL_LIMIT).reverse();
  const byRef = new Map(rows.map((r) => [photoRef(r.id), r]));
  const refByKey = new Map(rows.map((r) => [r.media_key, photoRef(r.id)]));
  const roll = rows.map((r) => ({
    ref: photoRef(r.id),
    description: r.description,
    mode: r.send_mode === 'auto' ? undefined : r.send_mode,
  }));
  return { roll, byRef, refByKey };
}

export async function toLibraryDTO(r: LibraryPhotoRow, media: MediaStore): Promise<LibraryPhotoDTO> {
  return {
    id: r.id,
    url: await media.url(r.media_key),
    width: r.width,
    height: r.height,
    description: r.description,
    sample: r.media_key.startsWith('asset:'),
    sendMode: r.send_mode,
    createdAt: r.created_at,
  };
}

/** Uses the given description, or asks Claude for one, or falls back to the file name. */
async function describe(
  responder: Responder | null,
  data: Uint8Array,
  mime: string,
  key: string,
  given?: string,
): Promise<string> {
  const trimmed = given?.trim();
  if (trimmed) return trimmed.slice(0, 300);
  if (responder) {
    try {
      return await responder.describe(data, mime);
    } catch {
      // fall back to the file name below
    }
  }
  const base = key.split('/').pop() ?? 'photo';
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'a photo';
}

export async function addLibraryPhoto(
  db: DB,
  media: MediaStore,
  responder: Responder | null,
  data: Uint8Array,
  description?: string,
): Promise<LibraryPhotoRow> {
  const saved = await media.save('library', data);
  const text = await describe(responder, data, saved.mime, saved.key, description);
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO library_photos (media_key, media_mime, width, height, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(saved.key, saved.mime, saved.width, saved.height, text, nowIso());
  return db.prepare('SELECT * FROM library_photos WHERE id = ?').get(lastInsertRowid) as LibraryPhotoRow;
}

/**
 * Adds photos that were put straight into the bucket's `library/` folder (for
 * example through the R2 dashboard), describing each one. Works in batches.
 */
export async function syncLibrary(
  db: DB,
  media: MediaStore,
  responder: Responder | null,
): Promise<{ added: number; remaining: number; skipped: string[] }> {
  const known = new Set((db.prepare('SELECT media_key FROM library_photos').all() as { media_key: string }[]).map((r) => r.media_key));
  const fresh = (await media.storage.list('library/')).filter((o) => !known.has(o.key));
  const skipped: string[] = [];
  let added = 0;
  for (const obj of fresh.slice(0, SYNC_BATCH)) {
    const data = await media.read(obj.key);
    const mime = data ? sniffImage(data) : null;
    if (!data || !mime) {
      skipped.push(obj.key);
      continue;
    }
    const { width, height } = dimensions(data);
    const text = await describe(responder, data, mime, obj.key);
    db.prepare(
      'INSERT OR IGNORE INTO library_photos (media_key, media_mime, width, height, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(obj.key, mime, width, height, text, nowIso());
    added++;
  }
  return { added, remaining: Math.max(0, fresh.length - SYNC_BATCH), skipped };
}
