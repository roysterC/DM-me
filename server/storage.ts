import fs from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';

export interface StoredObject {
  key: string;
  size: number;
}

/** Where photos live: the server's disk (development) or S3-compatible object storage. */
export interface Storage {
  readonly kind: 'local' | 's3';
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  /** A pre-signed GET URL valid until at least `expiresAt` (S3 only). */
  presign?(key: string, signedAt: Date, expiresAt: Date): Promise<string>;
}

/** Keys may contain spaces and punctuation (files added through a bucket's dashboard), but never path tricks. */
const safeKey = (key: string) => {
  const bad =
    !key ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    /[\u0000-\u001f]/.test(key) ||
    key.split('/').some((part) => part === '..' || part === '.');
  if (bad) throw new Error(`Bad storage key: ${key}`);
  return key;
};

export class LocalStorage implements Storage {
  readonly kind = 'local';
  constructor(private root: string) {}

  private file(key: string) {
    return path.join(this.root, safeKey(key));
  }

  async put(key: string, data: Uint8Array) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await fs.readFile(this.file(key)));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }

  async list(prefix: string) {
    const dir = path.join(this.root, safeKey(prefix.replace(/\/$/, '')));
    const out: StoredObject[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name));
      if (stat.isFile()) out.push({ key: `${prefix.replace(/\/$/, '')}/${name}`, size: stat.size });
    }
    return out;
  }
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `https://endpoint/bucket/key` (default, works with R2, B2, MinIO) instead of `https://bucket.endpoint/key`. */
  pathStyle: boolean;
  fetch?: typeof fetch;
}

/** Any S3-compatible bucket: Cloudflare R2, Backblaze B2, AWS S3, Supabase Storage, MinIO. */
export class S3Storage implements Storage {
  readonly kind = 's3';
  private client: AwsClient;
  private doFetch: typeof fetch;

  constructor(private o: S3Options) {
    this.client = new AwsClient({
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      service: 's3',
      region: o.region,
      retries: 2,
    });
    this.doFetch = o.fetch ?? fetch;
  }

  private objectUrl(key = '') {
    const base = new URL(this.o.endpoint);
    const encoded = key ? safeKey(key).split('/').map(encodeRfc3986).join('/') : '';
    if (this.o.pathStyle) return `${base.origin}/${this.o.bucket}/${encoded}`;
    return `${base.protocol}//${this.o.bucket}.${base.host}/${encoded}`;
  }

  private async send(url: string, init: RequestInit = {}) {
    const req = await this.client.sign(url, init);
    return this.doFetch(req);
  }

  async put(key: string, data: Uint8Array, mime: string) {
    const res = await this.send(this.objectUrl(key), {
      method: 'PUT',
      body: data as Uint8Array<ArrayBuffer>,
      headers: { 'content-type': mime, 'content-length': String(data.byteLength) },
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${await res.text()}`);
  }

  async get(key: string) {
    const res = await this.send(this.objectUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string) {
    const res = await this.send(this.objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
  }

  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | null = null;
    do {
      const url = new URL(this.objectUrl());
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const res = await this.send(url.toString());
      if (!res.ok) throw new Error(`Storage listing failed (${res.status})`);
      const xml = await res.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? '');
        const size = Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
        if (key && !key.endsWith('/')) out.push({ key, size });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? '') || null
        : null;
    } while (token);
    return out;
  }

  async presign(key: string, signedAt: Date, expiresAt: Date) {
    const url = new URL(this.objectUrl(key));
    const seconds = Math.max(1, Math.min(604_800, Math.ceil((expiresAt.getTime() - signedAt.getTime()) / 1000)));
    url.searchParams.set('X-Amz-Expires', String(seconds));
    const datetime = signedAt.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const signed = await this.client.sign(url.toString(), { method: 'GET', aws: { signQuery: true, datetime } });
    return signed.url;
  }
}

/** S3 canonical encoding: encodeURIComponent plus !'()* */
function encodeRfc3986(s: string) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
