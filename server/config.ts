import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

export interface Config {
  port: number;
  dataDir: string;
  assetsDir: string;
  clientDir: string;
  anthropicModel: string;
  fakeAi: boolean;
  adminUsernames: Set<string>;
  autoStories: boolean;
  /** Seconds a view-once or replay photo stays on screen. */
  photoSeconds: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  return {
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    assetsDir: path.resolve(env.ASSETS_DIR ?? 'server/assets'),
    clientDir: path.resolve(env.CLIENT_DIR ?? 'dist/client'),
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    fakeAi: env.DM_ME_FAKE_AI === '1',
    adminUsernames: new Set(
      (env.ADMIN_USERNAMES ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    autoStories: env.AUTO_STORIES !== 'off',
    photoSeconds: Number(env.PHOTO_SECONDS ?? 5),
    ...overrides,
  };
}
