# syntax=docker/dockerfile:1
# ── Diagram Hub — Dockerfile ──────────────────────────────────────────────────
#
# Builds a small Node.js 20 image on Alpine Linux.
# The SQLite database is kept in /data (mount a named volume there).
#
# Build:   docker build -t diagram-hub .
# Run:     docker run -p 3000:3000 \
#            -e EDIT_PASSPHRASE=changeme \
#            -e DRAWIO_EMBED_URL=https://drawio.example.com \
#            -v diagram_data:/data \
#            diagram-hub

FROM node:20-alpine

# Install build tools needed to compile better-sqlite3 native bindings.
RUN apk add --no-cache python3 make g++

# Run as a non-root user for security.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files first so Docker layer caching works well.
# Kept inside server/ so it stays a sibling of public/, matching the
# server/ + public/ layout that server.js's express.static path
# (path.join(__dirname, '..', 'public')) expects.
COPY server/package.json server/package-lock.json* ./server/

# Install production dependencies only.
RUN cd server && npm install --omit=dev

# Copy application source, preserving the server/ + public/ sibling layout.
COPY server/server.js server/db.js ./server/
COPY public/                       ./public/

# Create /data directory owned by our non-root user.
RUN mkdir -p /data && chown appuser:appgroup /data

# Switch to non-root user.
USER appuser

# The SQLite file lives in this volume-mountable directory.
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000

# Docker healthcheck — lightweight endpoint that doesn't touch the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server/server.js"]
