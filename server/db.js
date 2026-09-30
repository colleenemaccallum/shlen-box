// Database: one SQLite file. There is deliberately no drafts table (drafts live on each phone).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL UNIQUE CHECK (role IN ('A','B')),
  mute INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  created TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
-- Passkeys (Face ID / fingerprint). Only public keys are stored.
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  keys TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- AI spending, one row per AI request. Holds amounts only, never text.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notified_pauses (
  pause_id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','try','ok')),
  checkin TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS status_requests (
  topic_id INTEGER PRIMARY KEY REFERENCES topics(id),
  by_person INTEGER NOT NULL,
  to_status TEXT NOT NULL,
  checkin TEXT,
  created TEXT NOT NULL
);
-- topic_id 0 means "delete everything"
CREATE TABLE IF NOT EXISTS delete_requests (
  topic_id INTEGER PRIMARY KEY,
  by_person INTEGER NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  author INTEGER NOT NULL REFERENCES people(id),
  text TEXT NOT NULL,
  created TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS card_points (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('draft','agreed','account')),
  account_of INTEGER,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_confirmations (
  point_id INTEGER NOT NULL REFERENCES card_points(id),
  person_id INTEGER NOT NULL,
  PRIMARY KEY (point_id, person_id)
);
CREATE TABLE IF NOT EXISTS pauses (
  id INTEGER PRIMARY KEY,
  by_person INTEGER NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  note TEXT,
  ended_early TEXT
);
CREATE TABLE IF NOT EXISTS urgent (
  id INTEGER PRIMARY KEY,
  author INTEGER NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_requests (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  by_person INTEGER NOT NULL,
  created TEXT NOT NULL
);
`;

export const DEFAULT_RULES = { morning_time: '09:00', tonight_time: '20:00' };
export const STARTER_TOPICS = [
  'Parenting', 'Household', 'Money', 'Plans', 'Relationship',
  'Something bothering me', 'A decision we need to make',
];

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const put = db.prepare('INSERT OR IGNORE INTO rules (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_RULES)) put.run(k, v);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
