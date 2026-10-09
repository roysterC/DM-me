import fs from 'node:fs';
import path from 'node:path';
import type { S3Options } from './storage';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

export interface Config {
  port: number;
  /** SQLite database, plus photos when no bucket is configured. */
  dataDir: string;
  assetsDir: string;
  clientDir: string;
  anthropicModel: string;
  fakeAi: boolean;
  /** Unlocks /admin (stories and Nova's camera roll). Empty disables the admin page. */
  adminPassword: string;
  /** Signs cookies and media links. Generated into the data directory when not set. */
  secret: string;
  s3: S3Options | null;
  autoStories: boolean;
  seedSamplePhotos: boolean;
  /** Seconds a view-once or replay photo stays on screen. */
  photoSeconds: number;
  /** Nova replies per visitor per day. */
  dailyReplyLimit: number;
}

function loadSecret(dataDir: string): string {
  if (process.env.SECRET) return process.env.SECRET;
  if (dataDir === ':memory:') return 'test-secret';
  const file = path.join(dataDir, 'secret.key');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

function loadS3(env: NodeJS.ProcessEnv): S3Options | null {
  if (!env.S3_BUCKET) return null;
  const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`S3_BUCKET is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing.`);
  return {
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION ?? 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    pathStyle: env.S3_PATH_STYLE !== 'false',
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const dataDir = overrides.dataDir ?? path.resolve(env.DATA_DIR ?? 'data');
  return {
    port: Number(env.PORT ?? 3000),
    dataDir,
    assetsDir: path.resolve(env.ASSETS_DIR ?? 'server/assets'),
    clientDir: path.resolve(env.CLIENT_DIR ?? 'dist/client'),
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
    fakeAi: env.DM_ME_FAKE_AI === '1',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    secret: overrides.secret ?? loadSecret(dataDir),
    s3: overrides.s3 !== undefined ? overrides.s3 : loadS3(env),
    autoStories: env.AUTO_STORIES !== 'off',
    seedSamplePhotos: env.SAMPLE_PHOTOS !== 'off',
    photoSeconds: Number(env.PHOTO_SECONDS ?? 5),
    dailyReplyLimit: Number(env.DAILY_REPLY_LIMIT ?? 200),
    ...overrides,
  };
}
