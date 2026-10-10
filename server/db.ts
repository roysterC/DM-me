import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PhotoMode, SendMode, Sender, StoryBg } from '../shared/types';

export type DB = Database.Database;

export interface VisitorRow {
  id: number;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  sender: Sender;
  kind: 'text' | 'photo' | 'story_reply';
  text: string | null;
  media_key: string | null;
  media_mime: string | null;
  media_width: number | null;
  media_height: number | null;
  photo_mode: PhotoMode | null;
  view_count: number;
  story_id: number | null;
  story_snapshot: string | null;
  heart_by_user: number;
  heart_by_ai: number;
  created_at: string;
  read_at: string | null;
}

export interface StoryRow {
  id: number;
  kind: 'photo' | 'text';
  media_key: string | null;
  media_mime: string | null;
  caption: string | null;
  bg: StoryBg | null;
  created_at: string;
  expires_at: string;
}

export interface LibraryPhotoRow {
  id: number;
  media_key: string;
  media_mime: string;
  width: number | null;
  height: number | null;
  description: string;
  created_at: string;
  hidden: number;
  send_mode: SendMode;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE visitors (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    visitor_id INTEGER NOT NULL UNIQUE REFERENCES visitors(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'ai')),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'photo', 'story_reply')),
    text TEXT,
    media_key TEXT,
    media_mime TEXT,
    media_width INTEGER,
    media_height INTEGER,
    photo_mode TEXT CHECK (photo_mode IN ('keep', 'once', 'replay')),
    view_count INTEGER NOT NULL DEFAULT 0,
    story_id INTEGER,
    story_snapshot TEXT,
    heart_by_user INTEGER NOT NULL DEFAULT 0,
    heart_by_ai INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX messages_by_conversation ON messages (conversation_id, id);
  CREATE TABLE stories (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'text')),
    media_key TEXT,
    media_mime TEXT,
    caption TEXT,
    bg TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX stories_by_expiry ON stories (expires_at);
  CREATE TABLE story_views (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (story_id, visitor_id)
  );
  CREATE TABLE story_likes (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, visitor_id)
  );
  CREATE TABLE library_photos (
    id INTEGER PRIMARY KEY,
    media_key TEXT NOT NULL UNIQUE,
    media_mime TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Removed from the camera roll but still shown in chats that received it.
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE reply_counts (
    visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (visitor_id, day)
  );
  `,
  `
  ALTER TABLE library_photos ADD COLUMN send_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (send_mode IN ('auto', 'keep', 'once', 'replay'));
  `,
];

export function openDb(dataDir: string): DB {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'dm-me.sqlite');
  }
  const db = new Database(file);
  // WAL is also what Litestream needs to back the database up continuously.
  db.pragma('journal_mode = WAL');
  // Wait instead of failing while a backup briefly holds the file.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const hasOldSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (hasOldSchema) {
    throw new Error(`${file} is from an earlier version with accounts. Delete it (and the data directory) to start fresh.`);
  }
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const nowIso = () => new Date().toISOString();
