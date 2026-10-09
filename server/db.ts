import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PhotoMode, Sender, StoryBg } from '../shared/types';

export type DB = Database.Database;

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  sender: Sender;
  kind: 'text' | 'photo' | 'story_reply';
  text: string | null;
  media_file: string | null;
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
  persona_id: string;
  kind: 'photo' | 'text';
  media_file: string | null;
  media_mime: string | null;
  caption: string | null;
  bg: StoryBg | null;
  created_at: string;
  expires_at: string;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, persona_id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'ai')),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'photo', 'story_reply')),
    text TEXT,
    media_file TEXT,
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
    persona_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'text')),
    media_file TEXT,
    media_mime TEXT,
    caption TEXT,
    bg TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX stories_by_persona ON stories (persona_id, expires_at);
  CREATE TABLE story_views (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (story_id, user_id)
  );
  CREATE TABLE story_likes (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, user_id)
  );
  `,
];

export function openDb(dataDir: string): DB {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'dm-me.sqlite');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
