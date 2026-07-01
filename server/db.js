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

const CURRENT_VERSION = 3;
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

console.log(`[db] Database ready at ${DB_PATH}`);

module.exports = db;
