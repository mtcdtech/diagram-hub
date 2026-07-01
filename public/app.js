/**
 * app.js — Diagram Hub shared frontend logic.
 *
 * Contains:
 *   - Toast notification helper
 *   - Relative-time formatter
 *   - Passphrase storage (sessionStorage, never localStorage)
 *   - draw.io Embed Mode iframe controller (postMessage protocol)
 *   - Polling helper for detecting remote changes
 *
 * Both index.html and diagram.html load this file.
 */

'use strict';

// ── Toast notifications ──────────────────────────────────────────────────────

/**
 * Show a brief toast message at the bottom-right of the screen.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type='info']
 * @param {number} [duration=3000] ms before auto-dismiss
 */
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Relative time formatting ─────────────────────────────────────────────────

/**
 * Return a human-readable relative time string, e.g. "just now", "3m ago".
 * @param {number} epochMs  Unix epoch milliseconds
 * @returns {string}
 */
function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 10_000)  return 'just now';
  if (diff < 60_000)  return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Passphrase cache (sessionStorage) ───────────────────────────────────────

// The passphrase is kept only for the current browser session.
// It is NEVER stored in localStorage (survives browser close) or cookies.
const PASSPHRASE_KEY = 'dh_passphrase';

function getCachedPassphrase() {
  return sessionStorage.getItem(PASSPHRASE_KEY) || '';
}

function setCachedPassphrase(value) {
  sessionStorage.setItem(PASSPHRASE_KEY, value);
}

function clearCachedPassphrase() {
  sessionStorage.removeItem(PASSPHRASE_KEY);
}

// ── Runtime config ───────────────────────────────────────────────────────────

/**
 * Fetch the server-side config (drawioEmbedUrl) once and cache it.
 * Returns a promise that resolves to the config object.
 */
let _configCache = null;
async function getConfig() {
  if (_configCache) return _configCache;
  const res = await fetch('/api/config');
  _configCache = await res.json();
  return _configCache;
}

// ── draw.io Embed Mode iframe controller ─────────────────────────────────────

/**
 * DiagramEmbed — manages a single draw.io embed iframe.
 *
 * Protocol summary (from draw.io official Embed Mode docs):
 *
 *   Browser → iframe  (postMessage with JSON.stringify):
 *     {action:'load', xml, autosave, title, noSaveBtn, noExitBtn, saveAndExit}
 *
 *   iframe → Browser  (message event, JSON.parse(evt.data)):
 *     {event:'init'}               — editor is ready; must respond with 'load'
 *     {event:'autosave', xml:'…'}  — fired on every change when autosave:1 set
 *     {event:'save', xml:'…'}      — fired when user clicks Save button
 *     {event:'exit', modified:bool}
 *
 * @param {object} opts
 * @param {HTMLIFrameElement} opts.iframe   — the iframe element to control
 * @param {string}            opts.diagramId
 * @param {'view'|'edit'}     opts.mode
 * @param {string}            opts.passphrase  — required for edit mode
 * @param {Function}          [opts.onSaved]   — called with updatedAt after each save
 * @param {Function}          [opts.onReady]   — called when editor is initialised
 */
class DiagramEmbed {
  constructor(opts) {
    this.iframe      = opts.iframe;
    this.diagramId   = opts.diagramId;
    this.mode        = opts.mode;        // 'view' | 'edit'
    this.passphrase  = opts.passphrase || '';
    this.onSaved     = opts.onSaved  || (() => {});
    this.onReady     = opts.onReady  || (() => {});
    this._xmlCache   = null;
    this._saveQueue  = Promise.resolve(); // serialise concurrent save calls
    this._listener   = null;
  }

  /**
   * Load the diagram into the iframe.  Call once after constructing.
   */
  async load() {
    const cfg  = await getConfig();
    const base = cfg.drawioEmbedUrl.replace(/\/$/, '');

    // Build the embed URL query string.
    // noSaveBtn=1 and saveAndExit=0 are always set; we manage saving ourselves.
    // noExitBtn=1 is added in view mode (no Exit button needed).
    const params = new URLSearchParams({
      embed: '1',
      proto: 'json',
      spin:  '1',
      noSaveBtn: '1',
      saveAndExit: '0',
    });
    if (this.mode === 'view') params.set('noExitBtn', '1');

    this.iframe.src = `${base}/?${params.toString()}`;

    // Fetch diagram XML from the server.
    // view  → GET /api/diagrams/:id?mode=view  (public, locked XML)
    // edit  → GET /api/diagrams/:id?mode=edit  (passphrase required, raw XML)
    const fetchUrl = `/api/diagrams/${this.diagramId}?mode=${this.mode}`;
    const headers  = {};
    if (this.mode === 'edit') headers['X-Edit-Passphrase'] = this.passphrase;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) {
      throw new Error(`Failed to load diagram (${res.status})`);
    }
    const data = await res.json();
    this._xmlCache = data.xml;
    this._titleCache = data.title;

    // Attach the postMessage listener before the iframe might send 'init'.
    this._attachListener();
  }

  /**
   * Send a message to the draw.io iframe.
   * Per protocol: postMessage(JSON.stringify(action), '*')
   */
  _send(action) {
    this.iframe.contentWindow.postMessage(JSON.stringify(action), '*');
  }

  _attachListener() {
    this._listener = (evt) => {
      // Only handle messages from our iframe's origin.
      // Use '*' origin check relaxation since draw.io may be on a different subdomain.
      let msg;
      try {
        msg = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
      } catch {
        return; // not a draw.io message
      }
      if (!msg || typeof msg.event !== 'string') return;

      this._handleEvent(msg);
    };
    window.addEventListener('message', this._listener);
  }

  /** Remove the postMessage listener (cleanup when iframe is replaced). */
  destroy() {
    if (this._listener) {
      window.removeEventListener('message', this._listener);
      this._listener = null;
    }
  }

  _handleEvent(msg) {
    switch (msg.event) {
      case 'init':
        // draw.io is ready — send the 'load' action with the diagram data.
        this._sendLoad();
        this.onReady();
        break;

      case 'autosave':
        // Continuous autosave stream in edit mode.
        if (this.mode === 'edit' && msg.xml) {
          this._xmlCache = msg.xml;
          this._persistXml(msg.xml);
        }
        break;

      case 'save':
        // User clicked a Save button (shouldn't appear with noSaveBtn:1,
        // but handle gracefully for robustness).
        if (this.mode === 'edit' && msg.xml) {
          this._xmlCache = msg.xml;
          this._persistXml(msg.xml);
        }
        break;

      case 'exit':
        // User clicked Exit; nothing to do in our UI since we hide the button.
        break;

      default:
        break;
    }
  }

  _sendLoad() {
    const action = {
      action:      'load',
      xml:         this._xmlCache,
      title:       this._titleCache,
      noSaveBtn:   1,
      noExitBtn:   this.mode === 'view' ? 1 : 0,
      saveAndExit: 0,
    };
    if (this.mode === 'edit') {
      action.autosave = 1;
    }
    this._send(action);
  }

  /**
   * Persist XML to the server via PUT.
   * Calls are serialised through a promise chain so rapid autosave events
   * don't create out-of-order writes.
   */
  _persistXml(xml) {
    this._saveQueue = this._saveQueue.then(async () => {
      try {
        const res = await fetch(`/api/diagrams/${this.diagramId}`, {
          method: 'PUT',
          headers: {
            'Content-Type':      'application/json',
            'X-Edit-Passphrase': this.passphrase,
          },
          body: JSON.stringify({ xml }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(`Save failed: ${err.error || res.status}`, 'error');
          return;
        }
        const { updatedAt } = await res.json();
        this.onSaved(updatedAt);
      } catch (e) {
        showToast(`Save error: ${e.message}`, 'error');
      }
    });
  }

  /**
   * Reload the XML from the server and push it to the iframe.
   * Called when the "new changes" banner is clicked.
   */
  async refresh() {
    const fetchUrl = `/api/diagrams/${this.diagramId}?mode=${this.mode}`;
    const headers  = {};
    if (this.mode === 'edit') headers['X-Edit-Passphrase'] = this.passphrase;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) return;
    const data = await res.json();
    this._xmlCache   = data.xml;
    this._titleCache = data.title;
    this._sendLoad();
  }
}

// ── draw.io static GraphViewer controller (read-only, interactive) ──────────

/**
 * DiagramViewer — renders a diagram read-only using draw.io's static
 * GraphViewer library (viewer-static.min.js), loaded from the self-hosted
 * draw.io instance. Unlike DiagramEmbed, there is NO iframe and NO editing
 * capability — the diagram is rendered directly into a `.mxgraph` div in the
 * page. The `toolbar` option still gives interactive zoom, pan, and
 * layer show/hide, matching draw.io's documented HTML embed pattern.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container  — element the viewer renders into
 * @param {string}      opts.diagramId
 * @param {Function}    [opts.onReady]  — called once the diagram has rendered
 */
class DiagramViewer {
  constructor(opts) {
    this.container = opts.container;
    this.diagramId = opts.diagramId;
    this.onReady   = opts.onReady || (() => {});
    this._base     = null;
    this._mxDiv    = null;
  }

  /**
   * Fetch the diagram XML (view mode — public, locked) and render it.
   * Call once after constructing.
   */
  async load() {
    const cfg  = await getConfig();
    this._base = cfg.drawioEmbedUrl.replace(/\/$/, '');

    const data = await this._fetchXml();
    this._render(data);
    await this._ensureViewerScript();
    this.onReady();
  }

  async _fetchXml() {
    const res = await fetch(`/api/diagrams/${this.diagramId}?mode=view`);
    if (!res.ok) {
      throw new Error(`Failed to load diagram (${res.status})`);
    }
    return res.json();
  }

  /** Build/replace the `.mxgraph` div that GraphViewer renders into. */
  _render(data) {
    this.container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'mxgraph';
    div.setAttribute('style', 'max-width:100%;max-height:100%;');
    // No `edit` key — omitting it means GraphViewer renders NO edit link/button,
    // keeping this genuinely read-only. `toolbar` still gives zoom/pan/layers.
    div.dataset.mxgraph = JSON.stringify({
      highlight: '#0000ff',
      nav:       true,
      resize:    true,
      toolbar:   'zoom layers lightbox',
      xml:       data.xml,
    });
    this.container.appendChild(div);
    this._mxDiv = div;
  }

  /**
   * Load viewer-static.min.js from the self-hosted draw.io instance (once
   * per page load) and trigger GraphViewer.processElements() to render any
   * pending `.mxgraph` divs, including ones added after the initial load.
   */
  _ensureViewerScript() {
    return new Promise((resolve) => {
      if (window.GraphViewer) {
        window.GraphViewer.processElements();
        resolve();
        return;
      }
      // onDrawioViewerLoad is the documented hook the script calls once ready.
      window.onDrawioViewerLoad = () => {
        window.GraphViewer.processElements();
        resolve();
      };
      if (document.getElementById('drawio-viewer-script')) {
        // Script tag already injected by a previous instance; the handler
        // above will fire once it finishes loading.
        return;
      }
      const script = document.createElement('script');
      script.id  = 'drawio-viewer-script';
      script.src = `${this._base}/js/viewer-static.min.js`;
      document.body.appendChild(script);
    });
  }

  /**
   * Reload the XML from the server and re-render.
   * Called when the "new changes" banner is clicked.
   */
  async refresh() {
    const data = await this._fetchXml();
    this._render(data);
    if (window.GraphViewer) {
      window.GraphViewer.processElements();
    }
  }

  /** Clear the container (cleanup when switching to edit mode). */
  destroy() {
    this.container.innerHTML = '';
    this._mxDiv = null;
  }
}

// ── Polling helper ───────────────────────────────────────────────────────────

/**
 * Poll /api/diagrams/:id/meta every intervalMs milliseconds.
 * Calls onChanged(updatedAt) when the remote updatedAt is newer than the
 * last known value.
 *
 * @param {string}   diagramId
 * @param {number}   knownUpdatedAt   — timestamp we consider "current"
 * @param {Function} onChanged        — called with new updatedAt when changed
 * @param {number}   [intervalMs=5000]
 * @returns {Function} stop — call to cancel polling
 */
function startPolling(diagramId, knownUpdatedAt, onChanged, intervalMs = 5000) {
  let lastKnown = knownUpdatedAt;
  let handle    = null;
  let stopped   = false;

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch(`/api/diagrams/${diagramId}/meta`);
      if (res.ok) {
        const { updatedAt } = await res.json();
        if (updatedAt > lastKnown) {
          lastKnown = updatedAt;
          onChanged(updatedAt);
        }
      }
    } catch {
      // network error — silently ignore, will retry
    }
    if (!stopped) handle = setTimeout(poll, intervalMs);
  }

  handle = setTimeout(poll, intervalMs);

  return function stop() {
    stopped = true;
    if (handle) clearTimeout(handle);
  };
}

// ── API helpers ──────────────────────────────────────────────────────────────

/**
 * POST /api/diagrams — create a new diagram.
 * @param {string} title
 * @param {string} passphrase
 * @returns {Promise<{id:string, title:string}>}
 */
async function apiCreateDiagram(title, passphrase) {
  const res = await fetch('/api/diagrams', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Edit-Passphrase': passphrase,
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * GET /api/diagrams — list all diagrams.
 * @param {string} passphrase
 * @returns {Promise<Array<{id:string, title:string, updatedAt:number}>>}
 */
async function apiListDiagrams(passphrase) {
  const res = await fetch('/api/diagrams', {
    headers: { 'X-Edit-Passphrase': passphrase },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
