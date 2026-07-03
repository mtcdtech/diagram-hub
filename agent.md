# Diagram Hub Workspace

This workspace contains the `diagram-hub` project: a Node.js companion app for a self-hosted `draw.io` instance, adding server-side persistence, public sharing, and passphrase-gated editing.

## Tech Stack
- **Frontend**: Vanilla HTML, CSS, JavaScript (using raw DOM, custom CSS, `DiagramEmbed` class, API polling helper). No frontend frameworks.
- **Backend**: Node.js + Express.
- **Database**: SQLite (using `better-sqlite3`, auto-migrated schema, WAL mode enabled).
- **Authentication**: Passphrase-gated dashboard/editing via `EDIT_PASSPHRASE` environment variable. Cryptographically secure timing-safe passphrase comparisons.
- **Iframe Integration**: Communication with draw.io via standard `postMessage` protocol (Embed Mode: `?embed=1&proto=json`).

## Core Features
- **Dashboard**: Edit-passphrase gated access to view list, create, edit, share, delete, and secure diagrams.
- **Per-Diagram Passphrase**: Ability to assign a custom passphrase to a specific diagram so it can be edited without the master shared passphrase.
- **Auto-Saving**: Continuous auto-saving from draw.io editor iframe pushed directly to SQLite.
- **View-Mode Locking**: Injects `locked="1"` onto root layer cells to prevent unauthorized drag/drop/modification while viewing.
- **Concurrent-Edit Banner**: Light polling loop that compares diagram metadata and warns users when someone else has saved a newer version.

## Version History
- **v1.3.2**: Fixed OIDC group names mapping (supports both dashes and underscores), restored the default fallback role mapping (commenter) so users can log in even before groups are linked, and added sso callback diagnostics.
- **v1.3.1**: Implemented `/api/iam/roles` IAM sync endpoint, prioritized `ms_email` display username per Display Rule, and denied access to users without mapped role groups.
- **v1.3.0**: Auto-populate author name from SSO profiles, replaced confirm browser alert with inline delete warnings inside comment cards, and added support for mapping user roles (admin, editor, commenter) to Authentik groups.
- **v1.2.0**: Added Authentik SSO OIDC authentication support, session storage in SQLite database, creator-based comment thread deletion ownership via commenter session cookies or SSO email accounts, and identity pill indicator components in headers.
- **v1.1.0**: Removed passphrase gate for adding/replying/updating/positioning comments; fixed comments dot drifting by tracking scroll offsets and subscribing to mxGraph view changes.
- **v1.0.0**: Initial workspace setup and repository clone.



## CI/CD and Deployment
- **Git Repository**: `https://github.com/mtcdtech/diagram-hub`
- **Docker Registry**: Image is hosted on GitHub Container Registry at `ghcr.io/mtcdtech/diagram-hub`.
- **CI/CD Workflow**: Triggers on push to `main` branch. GitHub Actions build and push the docker image tagged as `latest` and with the commit SHA.
- **Deployment Script**: [deploy_draw.py](file:///Users/benny2168/Dockers/MTCD/docker-1/antigravity/mtcd-workspaces/draw%20diagram/deploy_draw.py) is used to automate build-push-redeploy pipeline. It triggers the update of Portainer Stack ID `99` using the short git commit SHA.
- **Run command**:
  ```bash
  # Step 1: Commit and push changes
  git add . && git commit -m "commit message" && git push
  # Step 2: Trigger Portainer stack update (wait for GitHub Actions image build to complete first)
  python3 deploy_draw.py
  ```
- **Target Server**: Synology NAS (`https://docker.server.mtcd.org`).
- **Persistence**: Docker named volume `diagram_hub_data` mapped to `/data`.

