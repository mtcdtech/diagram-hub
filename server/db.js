/**
 * db.js — SQLite database setup and migrations for Diagram Hub.
 *
 * Uses better-sqlite3 (synchronous API) for simplicity.
 * The database file is stored at ${DATA_DIR}/diagrams.db so it can
 * be mounted as a Docker volume for persistence.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// DATA_DIR defaults to the directory above server/ (project root) for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Ensure the data directory exists.
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'diagrams.db');

// Open (or create) the database.
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent-read performance (multiple browser
// tabs polling /meta won't block each other).
db.pragma('journal_mode = WAL');

// --- Schema migrations ---------------------------------------------------
// We use a simple integer user_version pragma as a schema version counter.
// Add new migration blocks below as the schema evolves; never change existing ones.

const CURRENT_VERSION = 4;
const version = db.pragma('user_version', { simple: true });

if (version < 1) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagrams (
      id         TEXT    PRIMARY KEY,   -- 10-char base62 slug
      title      TEXT    NOT NULL,
      xml        TEXT    NOT NULL,      -- mxGraphModel XML (master copy, never locked)
      updated_at INTEGER NOT NULL       -- Unix epoch ms
    );
  `);
  db.pragma('user_version = 1');
  console.log('[db] Schema migrated to version 1');
}

if (version < 2) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.pragma('user_version = 2');
  console.log('[db] Schema migrated to version 2');
}

if (version < 3) {
  // Optional per-diagram passphrase. NULL means "no individual passphrase
  // set" — the diagram is protected only by the shared/master passphrase.
  // When set, it grants edit access to that diagram alone; the shared
  // passphrase always continues to work everywhere as a master key.
  db.exec(`ALTER TABLE diagrams ADD COLUMN passphrase TEXT`);
  db.pragma('user_version = 3');
  console.log('[db] Schema migrated to version 3');
}

if (version < 4) {
  // Threaded comments anchored to a point on a diagram.
  // status: 'open' | 'resolved'. priority: 'low' | 'medium' | 'high'.
  // x/y are graph-model coordinates (View mode) or a best-effort
  // page-fraction-derived approximation (Edit mode) — see app.js for the
  // coordinate math used when placing/rendering pins.
  // No SQLite foreign keys are declared (this codebase does not enable
  // `PRAGMA foreign_keys`); deletes are cascaded manually in server.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id          TEXT    PRIMARY KEY,
      diagram_id  TEXT    NOT NULL,
      x           REAL    NOT NULL,
      y           REAL    NOT NULL,
      priority    TEXT    NOT NULL DEFAULT 'medium',
      status      TEXT    NOT NULL DEFAULT 'open',
      author_name TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_comments_diagram_id ON comments(diagram_id);

    CREATE TABLE IF NOT EXISTS comment_replies (
      id          TEXT    PRIMARY KEY,
      comment_id  TEXT    NOT NULL,
      author_name TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comment_replies_comment_id ON comment_replies(comment_id);
  `);
  db.pragma('user_version = 4');
  console.log('[db] Schema migrated to version 4');
}

console.log(`[db] Database ready at ${DB_PATH}`);

module.exports = db;
