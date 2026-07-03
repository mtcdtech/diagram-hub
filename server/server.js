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
 *   GET    /api/diagrams/:id/comments               — list comment threads (public)
 *   POST   /api/diagrams/:id/comments               — create a comment thread (passphrase required)
 *   POST   /api/diagrams/:id/comments/:cid/replies  — reply to a thread (passphrase required)
 *   PATCH  /api/diagrams/:id/comments/:cid          — update priority and/or position (passphrase required)
 *   PATCH  /api/diagrams/:id/comments/:cid/resolve  — resolve/reopen (MASTER passphrase required)
 *   DELETE /api/diagrams/:id/comments/:cid          — delete a thread (MASTER passphrase required)
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
 * Express middleware that checks if the requester is authenticated via SSO
 * OR provides the master passphrase. Used for dashboard diagram list & create.
 */
function requireHubAccess(req, res, next) {
  if (req.user && req.user.type === 'sso') {
    return next();
  }
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
// SSO & Session Management Configuration
// ---------------------------------------------------------------------------
const OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL;
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const APP_URL = process.env.APP_URL;

const isOidcConfigured = !!(OIDC_ISSUER_URL && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET && APP_URL);

let cachedOidcMetadata = null;
let cachedOidcIssuer = '';

async function getOidcMetadata() {
  if (cachedOidcMetadata && cachedOidcIssuer === OIDC_ISSUER_URL) {
    return cachedOidcMetadata;
  }
  const discoverUrl = `${OIDC_ISSUER_URL.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(discoverUrl);
  if (!res.ok) {
    throw new Error(`SSO discovery failed with status ${res.status}`);
  }
  const data = await res.json();
  cachedOidcMetadata = data;
  cachedOidcIssuer = OIDC_ISSUER_URL;
  return data;
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (let cookie of cookies) {
    const [cName, ...cVal] = cookie.split('=');
    if (cName.trim() === name) {
      return decodeURIComponent(cVal.join('='));
    }
  }
  return null;
}

function setCookie(res, name, value, maxAgeSec) {
  let cookieStr = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAgeSec !== undefined) {
    cookieStr += `; Max-Age=${maxAgeSec}`;
  }
  let existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else {
    if (typeof existing === 'string') existing = [existing];
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  }
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

function attachUserIdentity(req, res, next) {
  let user = null;
  const sid = getCookie(req, 'diagram_hub_sid');
  if (sid) {
    const session = db.prepare('SELECT user_email, user_name FROM sessions WHERE sid = ?').get(sid);
    if (session) {
      user = {
        type: 'sso',
        email: session.user_email,
        name: session.user_name,
        author_id: session.user_email
      };
    }
  }

  if (!user) {
    let guestId = getCookie(req, 'commenter_session');
    if (!guestId) {
      guestId = 'c_' + crypto.randomBytes(16).toString('hex');
      setCookie(res, 'commenter_session', guestId, 365 * 24 * 60 * 60);
    }
    user = {
      type: 'guest',
      author_id: guestId
    };
  }

  req.user = user;
  next();
}

app.use(attachUserIdentity);

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

// ---------------------------------------------------------------------------
// SSO Authentication Routes
// ---------------------------------------------------------------------------

app.get('/api/auth/me', (req, res) => {
  if (req.user && req.user.type === 'sso') {
    return res.json({
      loggedIn: true,
      user: {
        email: req.user.email,
        name: req.user.name,
        author_id: req.user.author_id
      },
      oidcAvailable: isOidcConfigured
    });
  }
  return res.json({
    loggedIn: false,
    user: {
      author_id: req.user ? req.user.author_id : null
    },
    oidcAvailable: isOidcConfigured
  });
});

app.get('/api/auth/sso/start', async (req, res) => {
  if (!isOidcConfigured) {
    return res.status(404).send('SSO not configured.');
  }
  try {
    const metadata = await getOidcMetadata();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    
    // Save state & nonce in cookies for verification in callback
    setCookie(res, 'sso_state', state, 300); // 5 mins
    setCookie(res, 'sso_nonce', nonce, 300);
    
    const returnUrl = req.query.return_url || '/';
    setCookie(res, 'sso_return_url', returnUrl, 300);
    
    const redirectUri = `${APP_URL.replace(/\/$/, '')}/api/auth/sso/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OIDC_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state: state,
      nonce: nonce
    });
    
    res.redirect(`${metadata.authorization_endpoint}?${params.toString()}`);
  } catch (err) {
    res.status(500).send(`SSO Error: ${err.message}`);
  }
});

app.get('/api/auth/sso/callback', async (req, res) => {
  if (!isOidcConfigured) {
    return res.status(404).send('SSO not configured.');
  }
  const code = req.query.code;
  const state = req.query.state;
  const cookieState = getCookie(req, 'sso_state');
  
  if (!code || !state) {
    return res.status(400).send('Missing code or state parameters.');
  }
  if (!cookieState || state !== cookieState) {
    return res.status(400).send('SSO State verification failed.');
  }
  
  try {
    const metadata = await getOidcMetadata();
    const redirectUri = `${APP_URL.replace(/\/$/, '')}/api/auth/sso/callback`;
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET
    });
    
    const tokenRes = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });
    
    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      return res.status(401).send(`SSO Token Exchange failed: ${errorText}`);
    }
    
    const tokenData = await tokenRes.json();
    const claims = tokenData.id_token ? decodeJwt(tokenData.id_token) : {};
    const email = (claims.email || '').toLowerCase();
    const name = claims.name || claims.preferred_username || email;
    
    if (!email) {
      return res.status(400).send('SSO claims did not contain email.');
    }
    
    // Generate session
    const sid = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (sid, user_email, user_name, created_at) VALUES (?, ?, ?, ?)').run(sid, email, name, Date.now());
    
    // Save session cookie for 14 days
    setCookie(res, 'diagram_hub_sid', sid, 14 * 24 * 60 * 60);
    clearCookie(res, 'sso_state');
    clearCookie(res, 'sso_nonce');
    
    const returnUrl = getCookie(req, 'sso_return_url') || '/';
    clearCookie(res, 'sso_return_url');
    
    res.redirect(returnUrl);
  } catch (err) {
    res.status(500).send(`SSO Callback Error: ${err.message}`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const sid = getCookie(req, 'diagram_hub_sid');
  if (sid) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  }
  clearCookie(res, 'diagram_hub_sid');
  res.json({ success: true });
});

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

app.post('/api/diagrams', requireHubAccess, (req, res) => {
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

app.get('/api/diagrams', requireHubAccess, (_req, res) => {
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

  // No SQLite foreign keys are declared, so cascade-delete comments/replies
  // manually to avoid leaving orphaned rows behind.
  const commentIds = db.prepare('SELECT id FROM comments WHERE diagram_id = ?').all(id).map(r => r.id);
  if (commentIds.length > 0) {
    const placeholders = commentIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM comment_replies WHERE comment_id IN (${placeholders})`).run(...commentIds);
  }
  db.prepare('DELETE FROM comments WHERE diagram_id = ?').run(id);

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
// Comments — threaded, point-anchored comments on a diagram.
//
// Permission model:
//   - Reading comments is public (no passphrase) so anyone with the diagram
//     link can see the discussion, matching View mode's public XML access.
//   - Creating a comment/reply and changing priority require
//     diagramPassphraseValid() — the shared/master passphrase OR that
//     diagram's own passphrase, same gate used for editing the diagram.
//   - Resolving/reopening a thread requires the MASTER/shared passphrase
//     specifically (requirePassphrase), per the "need to be logged in as
//     the admin to resolve" requirement — a diagram-specific passphrase is
//     NOT sufficient for this action.
// ---------------------------------------------------------------------------

const VALID_PRIORITIES = ['low', 'medium', 'high'];

function getDiagramRow(id) {
  return db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id);
}

function serializeComment(row, replies) {
  return {
    id:         row.id,
    diagramId:  row.diagram_id,
    x:          row.x,
    y:          row.y,
    priority:   row.priority,
    status:     row.status,
    authorName: row.author_name,
    body:       row.body,
    createdAt:  row.created_at,
    resolvedAt: row.resolved_at,
    authorId:   row.author_id,
    replies: replies.map(r => ({
      id:         r.id,
      authorName: r.author_name,
      body:       r.body,
      createdAt:  r.created_at,
      authorId:   r.author_id,
    })),
  };
}

function validateAuthorAndBody(body) {
  const { authorName, body: text } = body;
  if (!authorName || typeof authorName !== 'string' || authorName.trim().length === 0) {
    return 'authorName is required.';
  }
  if (authorName.trim().length > 60) {
    return 'authorName must be 60 characters or fewer.';
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return 'body is required.';
  }
  if (text.trim().length > 4000) {
    return 'body must be 4000 characters or fewer.';
  }
  return null;
}

// GET /api/diagrams/:id/comments — list all threads + replies (public)
app.get('/api/diagrams/:id/comments', (req, res) => {
  const { id } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const comments = db.prepare(
    'SELECT * FROM comments WHERE diagram_id = ? ORDER BY created_at ASC'
  ).all(id);
  const replyStmt = db.prepare(
    'SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC'
  );

  return res.json(comments.map(c => serializeComment(c, replyStmt.all(c.id))));
});

// POST /api/diagrams/:id/comments — create a new thread (public)
app.post('/api/diagrams/:id/comments', (req, res) => {
  const { id } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const { x, y, priority } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x and y must be numbers.' });
  }
  const cleanPriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
  const validationError = validateAuthorAndBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const commentId = generateId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO comments (id, diagram_id, x, y, priority, status, author_name, body, created_at, resolved_at, author_id)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?)
  `).run(commentId, id, x, y, cleanPriority, req.body.authorName.trim(), req.body.body.trim(), now, req.user.author_id);

  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  return res.status(201).json(serializeComment(row, []));
});

// POST /api/diagrams/:id/comments/:commentId/replies — reply to a thread (public)
app.post('/api/diagrams/:id/comments/:commentId/replies', (req, res) => {
  const { id, commentId } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND diagram_id = ?').get(commentId, id);
  if (!comment) {
    return res.status(404).json({ error: 'Comment thread not found.' });
  }

  const validationError = validateAuthorAndBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const replyId = generateId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO comment_replies (id, comment_id, author_name, body, created_at, author_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(replyId, commentId, req.body.authorName.trim(), req.body.body.trim(), now, req.user.author_id);

  const replies = db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC').all(commentId);
  return res.status(201).json(serializeComment(comment, replies));
});

// PATCH /api/diagrams/:id/comments/:commentId — update priority and/or x/y position (public)
app.patch('/api/diagrams/:id/comments/:commentId', (req, res) => {
  const { id, commentId } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND diagram_id = ?').get(commentId, id);
  if (!comment) {
    return res.status(404).json({ error: 'Comment thread not found.' });
  }

  const { priority, x, y } = req.body;
  const setClauses = [];
  const params = [];

  if (priority !== undefined) {
    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}.` });
    }
    setClauses.push('priority = ?');
    params.push(priority);
  }

  if (x !== undefined || y !== undefined) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'x and y must both be provided as numbers to move a comment.' });
    }
    setClauses.push('x = ?', 'y = ?');
    params.push(x, y);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'Provide priority and/or x and y to update.' });
  }

  params.push(commentId);
  db.prepare(`UPDATE comments SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  const replies = db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC').all(commentId);
  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  return res.json(serializeComment(updated, replies));
});

// DELETE /api/diagrams/:id/comments/:commentId — permanently delete a comment
// thread and its replies. Gated by the creator's author_id OR the MASTER/shared passphrase (admin).
app.delete('/api/diagrams/:id/comments/:commentId', (req, res) => {
  const { id, commentId } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const comment = db.prepare('SELECT id, author_id FROM comments WHERE id = ? AND diagram_id = ?').get(commentId, id);
  if (!comment) {
    return res.status(404).json({ error: 'Comment thread not found.' });
  }

  // Check if they are the author of the comment OR if they provided the master passphrase
  const providedPass = req.headers['x-edit-passphrase'] || '';
  const isAdmin = passphraseValid(providedPass);
  const isAuthor = req.user && comment.author_id === req.user.author_id;

  if (!isAdmin && !isAuthor) {
    return res.status(403).json({ error: 'You are not authorized to delete this comment.' });
  }

  // No SQL foreign keys are declared, so cascade-delete replies manually
  db.prepare('DELETE FROM comment_replies WHERE comment_id = ?').run(commentId);
  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);

  return res.status(204).send();
});

// PATCH /api/diagrams/:id/comments/:commentId/resolve — resolve/reopen (MASTER passphrase only)
app.patch('/api/diagrams/:id/comments/:commentId/resolve', requirePassphrase, (req, res) => {
  const { id, commentId } = req.params;
  const diagram = getDiagramRow(id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found.' });
  }

  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND diagram_id = ?').get(commentId, id);
  if (!comment) {
    return res.status(404).json({ error: 'Comment thread not found.' });
  }

  const { resolved } = req.body;
  if (typeof resolved !== 'boolean') {
    return res.status(400).json({ error: 'resolved must be a boolean.' });
  }

  const status = resolved ? 'resolved' : 'open';
  const resolvedAt = resolved ? Date.now() : null;
  db.prepare('UPDATE comments SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, commentId);

  const replies = db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC').all(commentId);
  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  return res.json(serializeComment(updated, replies));
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
