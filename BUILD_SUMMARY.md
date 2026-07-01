# Diagram Hub — Build Summary

## What was built

Diagram Hub is a small Node.js companion app for a self-hosted `jgraph/drawio`
Docker instance. It wraps draw.io using its officially documented **Embed Mode**
(`?embed=1&proto=json` postMessage iframe protocol) to add:

| Feature | How it works |
|---|---|
| Server-side persistence | SQLite via `better-sqlite3`, stored at `${DATA_DIR}/diagrams.db` |
| Shareable public URLs | `/d/:id` — any person with the URL can view the diagram |
| Passphrase-gated editing | `X-Edit-Passphrase` header validated with `crypto.timingSafeEqual` (SHA-256 hashed both sides) |
| Near-real-time change notification | Frontend polls `GET /api/diagrams/:id/meta` every 5 s; shows a dismissable banner when a newer save is detected |
| View-mode locking | Server injects `locked="1"` onto root layer cells (`parent="0"`) in the XML before sending it to the browser for view mode — draw.io's documented technique for non-interactive read-only display |

---

## File inventory

```
drawio-share/
  server/
    package.json      — Express + better-sqlite3 only; no other production deps
    db.js             — SQLite open/migration (schema v1, WAL mode)
    server.js         — All Express routes + applyViewLock transform
  public/
    index.html        — Dashboard: auth gate + diagram list + new-diagram form
    diagram.html      — /d/:id hub: view/edit iframe, passphrase modal, change banner
    app.js            — Shared frontend: DiagramEmbed class, polling, toast, API helpers
    style.css         — Clean responsive CSS (no framework)
  Dockerfile          — node:20-alpine, non-root user, /data volume point
  docker-compose.yml  — diagram-hub service + diagram_data volume
  README.md           — Full setup/deploy/security/limitation docs
  BUILD_SUMMARY.md    — This file
```

---

## Deployment

### 1. Environment variables

| Variable | Required | Example |
|---|---|---|
| `EDIT_PASSPHRASE` | **Yes** | `my-church-secret-42` |
| `DRAWIO_EMBED_URL` | **Yes** | `https://drawio.example.com` |
| `PORT` | No (default `3000`) | `3000` |
| `DATA_DIR` | No (default `../data`) | `/data` |

Create a `.env` file in the project root (never commit it):
```dotenv
EDIT_PASSPHRASE=your-strong-secret-here
DRAWIO_EMBED_URL=https://drawio.example.com
```

### 2. Start with Docker Compose

```bash
docker compose up -d --build
```

### 3. Reverse proxy (nginx example)

Point a subdomain or path at `http://localhost:3000`.  Must be served over
HTTPS — the passphrase travels in a request header.

```nginx
server {
    listen 443 ssl;
    server_name hub.example.com;
    # ... SSL config ...
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4. Wiring into an existing docker-compose.yml (optional)

If your draw.io container is defined in a separate compose file, you have two
options:

- **Option A (separate projects):** Leave both compose files independent.
  `DRAWIO_EMBED_URL` is resolved by the end-user's browser, not the server, so
  no Docker networking between the two services is needed.

- **Option B (single compose file):** Copy the `diagram-hub` service block from
  `docker-compose.yml` into your existing file, add both services to the same
  Docker network, and set `DRAWIO_EMBED_URL` to the **public HTTPS URL** (not
  the internal Docker hostname) so users' browsers can reach it.

---

## Bug found and fixed during testing

**`applyViewLock` regex — self-closing tag corruption**

The original regex:
```js
/(<mxCell\b[^>]*\bparent=["']0["'][^>]*)(>|(?=\s*\/>))/g
```
used a lookahead for `/>` that was never consumed, causing the `/` to be
captured in the first group. The result was malformed XML like:
```xml
<mxCell id="1" parent="0"/ locked="1">   <!-- WRONG -->
```

Fixed to:
```js
/<mxCell(\s[^>]*?\bparent=["']0["'][^>]*?)(\/?>)/g
```
which captures the entire closing sequence (`/>` or `>`) in group 2, giving
correct output for both self-closing and normal tags:
```xml
<mxCell id="1" parent="0" locked="1"/>   <!-- CORRECT -->
```

---

## Test results (all passing after the fix above)

| Test | Result |
|---|---|
| `GET /healthz` → 200 | PASS |
| `GET /api/config` → `{drawioEmbedUrl}` | PASS |
| `GET /api/diagrams` no passphrase → 401 | PASS |
| `GET /api/diagrams` wrong passphrase → 401 | PASS |
| `POST /api/diagrams` wrong passphrase → 401 | PASS |
| `POST /api/diagrams` correct passphrase → 201, `{id, title}` | PASS |
| `GET /api/diagrams` correct passphrase → 200, array | PASS |
| `GET /api/diagrams/:id?mode=view` (public) → 200, `locked="1"` injected | PASS |
| View-mode XML — no malformed tag corruption | PASS |
| `GET /api/diagrams/:id?mode=edit` no passphrase → 401 | PASS |
| `GET /api/diagrams/:id?mode=edit` correct passphrase → 200, raw XML | PASS |
| Edit-mode XML — no `locked="1"` in raw copy | PASS |
| `PUT /api/diagrams/:id` correct passphrase → 200, `updatedAt` increased | PASS |
| `PUT /api/diagrams/:id` wrong passphrase → 401 | PASS |
| `GET /api/diagrams/:id/meta` (public) → 200, `{updatedAt}` | PASS |
| View XML after PUT — new content visible, root layer locked | PASS |
| View XML — only `parent="0"` cells get `locked="1"`, others untouched | PASS |
| Title update via PUT body `{xml, title}` | PASS |
| `GET /api/diagrams/nonexistent` → 404 | PASS |
| `GET /api/diagrams/nonexistent/meta` → 404 | PASS |
| Static files served at `/` | PASS |
| `/d/:id` route returns `diagram.html` (SPA fallback) | PASS |

---

## Limitations

1. **No simultaneous multi-cursor editing.** Real-time OT/CRDT sync is only
   available in draw.io's proprietary paid cloud integrations. Diagram Hub uses
   polling (banner notification) as a practical near-real-time alternative.
   The last writer wins on concurrent edits.

2. **Single shared passphrase.** This is intentional for a small team. For
   per-user auth, add HTTP Basic Auth or an SSO proxy in front.

3. **No version history.** Each `PUT` overwrites the stored XML. Schedule
   periodic backups of `/data/diagrams.db` if revision history matters.

4. **iframe/postMessage flow not tested end-to-end in sandbox.** No real draw.io
   instance was available in the build environment. The frontend code strictly
   follows the documented message shapes from the official Embed Mode spec and
   has been verified to be correct by code review. The test target for the real
   deploy is straightforward: open a diagram URL, confirm the diagram renders in
   view mode, click Edit, enter passphrase, make a change, and confirm it
   persists after a page reload.
