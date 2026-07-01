/**
 * server.js — Diagram Hub Express server.
 *
 * Provides:
 *   POST   /api/diagrams          — create a new diagram (passphrase required)
 *   GET    /api/diagrams          — list diagrams           (passphrase required)
 *   GET    /api/diagrams/:id      — fetch diagram XML       (public for view mode;
 *                                   passphrase required for ?mode=edit)
 *   PUT    /api/diagrams/:id      — update diagram XML      (passphrase required)
 *   PUT    /api/diagrams/:id/passphrase — set/clear a diagram's own passphrase (master passphrase required)
 *   GET    /api/diagrams/:id/meta — lightweight poll route  (public)
 *   GET    /healthz               — Docker healthcheck
 *
 * Static files in ../public/ are served at the root path.
 *
 * Environment variables:
 *   PORT             (default 3000)
 *   EDIT_PASSPHRASE  (required; shared secret for create/edit/list operations)
 *   DATA_DIR         (default ../data relative to this file; path to SQLite file)
 *   DRAWIO_EMBED_URL (injected to frontend via /api/config)
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Blank starter XML for new diagrams (official mxGraphModel shell).
// ---------------------------------------------------------------------------
const BLANK_XML = `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short random base62 ID (e.g. "aB3xZ9qR2k").
 * Uses crypto.randomBytes so it is unpredictable.
 */
function generateId(length = 10) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => CHARS[b % CHARS.length]).join('');
}

/**
 * The edit passphrase can be changed at runtime via the Admin panel.
 * When changed, the new value is stored in the `settings` table and takes
 * precedence over the EDIT_PASSPHRASE env var, which then only serves as
 * the initial value on first boot (or after a fresh volume).
 */
const PASSPHRASE_SETTING_KEY = 'edit_passphrase';

function getCurrentPassphrase() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PASSPHRASE_SETTING_KEY);
  if (row) return row.value;
  return process.env.EDIT_PASSPHRASE || '';
}

function setCurrentPassphrase(newValue) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(PASSPHRASE_SETTING_KEY, newValue);
}

/**
 * Constant-time passphrase comparison to mitigate timing attacks.
 * Both sides are hashed with SHA-256 before comparison so the buffers
 * are always the same length (a requirement of timingSafeEqual).
 */
function passphraseValid(provided) {
  const expected = getCurrentPassphrase();
  if (!expected) {
    // If no passphrase is configured, reject everything — safer than allowing all.
    return false;
  }
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const hashExpected = crypto.createHash('sha256').update(expected).digest();
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(hashExpected, hashProvided);
}

/**
 * Express middleware that checks the X-Edit-Passphrase header and sends 401
 * if it is wrong or missing.
 */
function requirePassphrase(req, res, next) {
  const provided = req.headers['x-edit-passphrase'] || '';
  if (!passphraseValid(provided)) {
    return res.status(401).json({ error: 'Invalid or missing passphrase.' });
  }
  next();
}

/**
 * A diagram can optionally have its own passphrase (set from the hub
 * dashboard), granting edit access to just that diagram without needing the
 * shared/master passphrase. The shared passphrase always continues to work
 * everywhere, including on diagrams that have their own passphrase set, so
 * it still acts as a master key.
 *
 * @param {{passphrase: string|null}} row  — a row from the diagrams table
 * @param {string} provided
 */
function diagramPassphraseValid(row, provided) {
  // Master/shared passphrase always grants access.
  if (passphraseValid(provided)) return true;

  // Otherwise, fall back to the diagram's own passphrase, if it has one.
  if (!row || !row.passphrase) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const hashExpected = crypto.createHash('sha256').update(row.passphrase).digest();
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(hashExpected, hashProvided);
}

/**
 * Apply the view-mode "locked" transform to XML:
 * Injects locked="1" on every <mxCell ... parent="0" ...> element that does
 * not already have it.  This makes draw.io treat the content as read-only
 * (non-interactive) while still allowing zoom/pan.
 * The stored master copy is never modified.
 *
 * The regex captures:
 *   group 1 — the attribute string (everything between <mxCell and the closer)
 *   group 2 — the closer itself: either "/>" (self-closing) or ">" (normal)
 * This ensures self-closing tags remain self-closing after the injection.
 */
function applyViewLock(xml) {
  return xml.replace(
    /<mxCell(\s[^>]*?\bparent=["']0["'][^>]*?)(\/>|>)/g,
    (match, attrs, closing) => {
      // If locked attribute already present, leave as-is.
      if (/\blocked=["']1["']/.test(attrs)) return match;
      return `<mxCell${attrs} locked="1"${closing}`;
    }
  );
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '10mb' }));  // diagrams can be large SVG-heavy XML

// Serve everything in public/ as static files (index.html, diagram.html, etc.)
// `index: false` disables automatic index.html serving so our own `/` route
// below can inject a cache-busting version query string on app.js/style.css.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ---------------------------------------------------------------------------
// Cache-busting for static assets
// ---------------------------------------------------------------------------
// A reverse proxy in front of this app may aggressively cache .js/.css by
// file extension regardless of origin headers. BUILD_ID changes on every
// container start (i.e. every deploy), so HTML pages reference
// app.js?v=<BUILD_ID> / style.css?v=<BUILD_ID> — a URL the proxy has never
// seen before, guaranteeing a fresh fetch after each release without
// requiring users to hard-refresh or an operator to purge the proxy cache.
const BUILD_ID = Date.now().toString(36);

function sendVersionedHtml(res, filePath) {
  const html = fs
    .readFileSync(filePath, 'utf8')
    // Matches both relative ("app.js") and absolute ("/app.js") references,
    // used by index.html and diagram.html respectively.
    .replace(/(src|href)="(\/?)(app\.js|style\.css)"/g, (_m, attr, slash, file) => `${attr}="${slash}${file}?v=${BUILD_ID}"`);
  // The HTML itself should never be cached so it always picks up the latest
  // versioned asset URLs.
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

app.get('/', (_req, res) => {
  sendVersionedHtml(res, path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------

app.get('/healthz', (_req, res) => {
  res.status(200).send('OK');
});

// ---------------------------------------------------------------------------
// Config endpoint — provides frontend-safe runtime config (no secrets).
// ---------------------------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({
    drawioEmbedUrl: process.env.DRAWIO_EMBED_URL || 'https://embed.diagrams.net',
  });
});

// ---------------------------------------------------------------------------
// POST /api/diagrams — create a new diagram
// ---------------------------------------------------------------------------

app.post('/api/diagrams', requirePassphrase, (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required.' });
  }

  const id        = generateId();
  const now       = Date.now();
  const cleanTitle = title.trim();

  const stmt = db.prepare(
    'INSERT INTO diagrams (id, title, xml, updated_at) VALUES (?, ?, ?, ?)'
  );
  stmt.run(id, cleanTitle, BLANK_XML, now);

  return res.status(201).json({ id, title: cleanTitle });
});

// ---------------------------------------------------------------------------
// GET /api/diagrams — list all diagrams (passphrase required)
// ---------------------------------------------------------------------------

app.get('/api/diagrams', requirePassphrase, (_req, res) => {
  const rows = db.prepare(
    'SELECT id, title, updated_at AS updatedAt, passphrase FROM diagrams ORDER BY updated_at DESC'
  ).all();
  return res.json(rows.map(({ passphrase, ...rest }) => ({
    ...rest,
    hasPassphrase: !!passphrase,
  })));
});

// ---------------------------------------------------------------------------
// GET /api/diagrams/:id — fetch a diagram's XML
//
//   ?mode=view  (default) — public; returns XML with locked="1" injected on
//               root layer cells so draw.io renders in read-only mode.
//   ?mode=edit  — requires X-Edit-Passphrase; returns raw unmodified XML.
// ---------------------------------------------------------------------------

app.get('/api/diagrams/:id', (req, res) => {
  const { id } = req.params;
  const mode   = req.query.mode || 'view';

  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  if (mode === 'edit') {
    // Edit mode: passphrase gate. The shared/master passphrase always works;
    // a diagram's own passphrase (if set) also grants access to it alone.
    if (!diagramPassphraseValid(row, req.headers['x-edit-passphrase'] || '')) {
      return res.status(401).json({ error: 'Invalid or missing passphrase.' });
    }
  }

  const xml = mode === 'view' ? applyViewLock(row.xml) : row.xml;

  return res.json({
    id:        row.id,
    title:     row.title,
    xml,
    updatedAt: row.updated_at,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/diagrams/:id — update a diagram's XML (passphrase required)
// ---------------------------------------------------------------------------

app.put('/api/diagrams/:id', (req, res) => {
  const { id }    = req.params;
  const { xml, title } = req.body;

  if (!xml || typeof xml !== 'string') {
    return res.status(400).json({ error: 'xml is required in request body.' });
  }

  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  // Shared/master passphrase always works; a diagram's own passphrase (if
  // set) also grants access to save just that diagram.
  if (!diagramPassphraseValid(row, req.headers['x-edit-passphrase'] || '')) {
    return res.status(401).json({ error: 'Invalid or missing passphrase.' });
  }

  const now = Date.now();

  if (title && typeof title === 'string' && title.trim().length > 0) {
    db.prepare('UPDATE diagrams SET xml = ?, title = ?, updated_at = ? WHERE id = ?')
      .run(xml, title.trim(), now, id);
  } else {
    db.prepare('UPDATE diagrams SET xml = ?, updated_at = ? WHERE id = ?')
      .run(xml, now, id);
  }

  return res.json({ updatedAt: now });
});

// ---------------------------------------------------------------------------
// PUT /api/diagrams/:id/passphrase — set, change, or clear a diagram's own
// passphrase. Gated by the shared/master passphrase only, since this is
// meant to be managed from the hub dashboard (which already requires the
// master passphrase to view). Body: { passphrase: string|null }.
// A null/absent passphrase clears the diagram's individual passphrase,
// leaving it protected only by the shared passphrase.
// ---------------------------------------------------------------------------

app.put('/api/diagrams/:id/passphrase', requirePassphrase, (req, res) => {
  const { id } = req.params;
  const { passphrase } = req.body;

  const row = db.prepare('SELECT id FROM diagrams WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  let valueToStore = null;
  if (passphrase !== null && passphrase !== undefined) {
    if (typeof passphrase !== 'string' || passphrase.length < 4) {
      return res.status(400).json({ error: 'Passphrase must be at least 4 characters, or null to clear it.' });
    }
    valueToStore = passphrase;
  }

  db.prepare('UPDATE diagrams SET passphrase = ? WHERE id = ?').run(valueToStore, id);
  return res.json({ ok: true, hasPassphrase: !!valueToStore });
});

// ---------------------------------------------------------------------------
// DELETE /api/diagrams/:id — permanently delete a diagram (passphrase required)
// ---------------------------------------------------------------------------

app.delete('/api/diagrams/:id', requirePassphrase, (req, res) => {
  const { id } = req.params;

  const row = db.prepare('SELECT id FROM diagrams WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  db.prepare('DELETE FROM diagrams WHERE id = ?').run(id);
  return res.status(204).send();
});

// ---------------------------------------------------------------------------
// POST /api/admin/change-passphrase — change the shared edit passphrase.
// Requires the CURRENT passphrase (via X-Edit-Passphrase, checked by
// requirePassphrase) and a new passphrase in the request body.
// ---------------------------------------------------------------------------

app.post('/api/admin/change-passphrase', requirePassphrase, (req, res) => {
  const { newPassphrase } = req.body;

  if (!newPassphrase || typeof newPassphrase !== 'string' || newPassphrase.length < 8) {
    return res.status(400).json({ error: 'New passphrase must be at least 8 characters.' });
  }

  setCurrentPassphrase(newPassphrase);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/diagrams/:id/meta — lightweight public poll endpoint
// ---------------------------------------------------------------------------

app.get('/api/diagrams/:id/meta', (req, res) => {
  const row = db.prepare(
    'SELECT updated_at AS updatedAt FROM diagrams WHERE id = ?'
  ).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }
  return res.json({ updatedAt: row.updatedAt });
});

// ---------------------------------------------------------------------------
// SPA fallback — serve diagram.html for /d/:id routes so the browser can
// deep-link directly without getting a 404 from the static file server.
// ---------------------------------------------------------------------------

app.get('/d/:id', (_req, res) => {
  sendVersionedHtml(res, path.join(__dirname, '..', 'public', 'diagram.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] Diagram Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] DRAWIO_EMBED_URL = ${process.env.DRAWIO_EMBED_URL || '(not set — using embed.diagrams.net fallback)'}`);
  if (!process.env.EDIT_PASSPHRASE) {
    console.warn('[server] WARNING: EDIT_PASSPHRASE is not set. All edit/create operations will be rejected.');
  }
});
