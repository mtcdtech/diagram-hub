# Diagram Hub

A small Node.js companion app for your self-hosted [draw.io](https://github.com/jgraph/drawio)
instance that adds server-side persistence, shareable public URLs, and
passphrase-gated editing — without modifying the draw.io container at all.

---

## How it works

draw.io ships an officially documented **Embed Mode** (`?embed=1&proto=json`).
When a page loads an `<iframe>` pointing at your draw.io instance with those
query parameters, the two sides communicate via `postMessage`:

- draw.io fires `{event:'init'}` once the editor is ready.
- Diagram Hub responds with `{action:'load', xml:'…', autosave:1, …}` to inject
  the saved XML and enable continuous auto-saving.
- draw.io fires `{event:'autosave', xml:'…'}` on every change.
- Diagram Hub persists those changes to a local SQLite database via `PUT /api/diagrams/:id`.

**View mode** uses the same iframe, but:
- Auto-save events are never wired up (no writes possible).
- The `noSaveBtn:1 noExitBtn:1` flags remove any interactive save UI.
- The XML is served with `locked="1"` injected onto the root layer cells
  (the documented draw.io technique to make content non-draggable while
  keeping zoom/pan available).

A lightweight polling loop (`GET /api/diagrams/:id/meta` every 5 s) detects
when another session has saved newer changes and surfaces a dismissable banner
so viewers and editors can reload without losing in-progress work.

---

## Quick start

### 1. Prerequisites

- Docker and Docker Compose (v2+)
- Your existing `jgraph/drawio` container running and accessible at a known HTTPS URL

### 2. Clone / copy this project

```bash
git clone https://your-repo/diagram-hub.git
cd diagram-hub
```

### 3. Create a `.env` file

```dotenv
EDIT_PASSPHRASE=choose-a-strong-secret
DRAWIO_EMBED_URL=https://drawio.example.com
PORT=3000
```

**Never commit `.env` to version control.**

### 4. Start the service

```bash
docker compose up -d --build
```

### 5. Wire up your reverse proxy

Point a path or subdomain at `http://localhost:3000`.  
Example (nginx snippet):

```nginx
server {
    listen 443 ssl;
    server_name hub.example.com;

    # ... your existing SSL config ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Open `https://hub.example.com` and enter your passphrase to start creating diagrams.

---

## Environment variables

| Variable            | Required | Default            | Description                                                                                  |
|---------------------|----------|--------------------|----------------------------------------------------------------------------------------------|
| `EDIT_PASSPHRASE`   | **Yes**  | —                  | Shared secret for create/list/edit operations. Use a strong random string (≥ 20 chars).      |
| `DRAWIO_EMBED_URL`  | **Yes**  | —                  | Public HTTPS base URL of your draw.io instance, e.g. `https://drawio.example.com`.          |
| `PORT`              | No       | `3000`             | TCP port the Express server listens on inside the container.                                  |
| `DATA_DIR`          | No       | `../data` (dev) / `/data` (Docker) | Directory where `diagrams.db` is stored.                          |

---

## API reference

All endpoints return JSON. Auth uses the `X-Edit-Passphrase` request header.

| Method | Path                        | Auth?       | Description                                               |
|--------|-----------------------------|-------------|-----------------------------------------------------------|
| POST   | `/api/diagrams`             | Required    | Create a diagram. Body: `{title}`.                        |
| GET    | `/api/diagrams`             | Required    | List all diagrams.                                        |
| GET    | `/api/diagrams/:id`         | View: no / Edit: required | Fetch diagram. `?mode=view` (default) returns locked XML; `?mode=edit` requires header and returns raw XML. |
| PUT    | `/api/diagrams/:id`         | Required    | Update diagram XML. Body: `{xml, title?}`.                |
| GET    | `/api/diagrams/:id/meta`    | No          | Returns `{updatedAt}` only (used for polling).            |
| GET    | `/healthz`                  | No          | Returns `200 OK` (Docker healthcheck).                    |
| GET    | `/api/config`               | No          | Returns `{drawioEmbedUrl}` for the frontend.              |

---

## Data backup

The SQLite database lives at `/data/diagrams.db` inside the container (backed by
the `diagram_data` Docker volume).

**One-shot backup:**
```bash
docker run --rm \
  -v diagram_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/diagrams-backup-$(date +%Y%m%d).tar.gz /data
```

**Restore:**
```bash
docker run --rm \
  -v diagram_data:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd / && tar xzf /backup/diagrams-backup-YYYYMMDD.tar.gz"
```

You can also copy the file directly from the volume mount point if your host
mounts it somewhere accessible.

---

## Security notes

1. **HTTPS only.** The passphrase is sent in a plain HTTP header
   (`X-Edit-Passphrase`). Always serve Diagram Hub through your existing HTTPS
   reverse proxy. Never expose port 3000 directly to the internet.

2. **Single shared secret.** `EDIT_PASSPHRASE` is one secret shared among all
   editors — it is not per-user authentication. Anyone with the passphrase can
   create and edit all diagrams. This is intentional for a small team / church
   office setting; if you need per-user access control, add a proper auth layer
   (e.g. HTTP Basic Auth at the reverse proxy level).

3. **Timing-safe comparison.** Passphrase validation uses Node's
   `crypto.timingSafeEqual` (after SHA-256 hashing both sides to equalise
   buffer lengths) to prevent timing-based enumeration attacks.

4. **View mode is truly public.** Anyone who has a `/d/:id` URL can view the
   diagram. If a diagram is sensitive, do not share the URL publicly.

5. **Raw XML gated behind passphrase.** `GET /api/diagrams/:id?mode=edit`
   requires the passphrase header, so anonymous viewers cannot download the
   unlocked master XML — only the locked view-mode XML is exposed without auth.

---

## Limitations

- **No simultaneous multi-cursor editing.** Real-time collaborative editing
  (Google Docs-style OT/CRDT sync) is only available in draw.io's proprietary
  paid integrations (Google Drive, OneDrive, Confluence). It is not achievable
  on a self-hosted OSS fork without a significant infrastructure build.  
  What Diagram Hub provides instead is *near-real-time polling*: if two people
  are editing concurrently, each will see a "New changes available" banner within
  ~5 seconds of the other saving. The last writer wins. For a small team this
  is usually acceptable; just coordinate verbally before editing the same diagram
  simultaneously.

- **Single SQLite file.** SQLite in WAL mode handles concurrent reads well, but
  is not designed for high write throughput. For a small team this is more than
  sufficient.

- **No versioning / undo history.** Each `PUT` overwrites the stored XML. If
  you need version history, schedule periodic backups of `/data/diagrams.db`
  and use SQLite's `.dump` or just file-level snapshots.

---

## draw.io Embed Mode — reference

The embed protocol Diagram Hub uses is documented at
`https://www.drawio.com/doc/faq/embed-mode` and the more detailed
`https://www.drawio.com/blog/embed-diagrams-confluence-cloud`.

Key points:
- iframe `src` = `{DRAWIO_EMBED_URL}/?embed=1&proto=json&spin=1&noSaveBtn=1&saveAndExit=0`
- All messages are JSON strings passed through `postMessage` / `message` events.
- The host **must** respond to `{event:'init'}` with a `{action:'load', xml}` message
  or the editor will stay on a loading spinner forever.
- Self-hosted `jgraph/drawio` instances support embed mode identically to
  `embed.diagrams.net` — no extra configuration on the draw.io side is needed.
