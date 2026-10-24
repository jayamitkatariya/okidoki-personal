# Okidoki backend (Convex)

All app data lives in Convex: accounts, settings, threads, memories, runs,
action previews, skills, routines, connectors, snapshots and share links.

## Local self-hosted Convex

Docker Desktop must be running.

```bash
cd backend
docker compose up -d
docker compose exec backend ./generate_admin_key.sh
```

Copy the key into `.env.local` (see `.env.local.example`) and keep
`CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210`.

```bash
cp .env.local.example .env.local
# edit .env.local with the generated admin key
npx convex dev
```

This pushes `convex/` to the backend and generates `_generated/`. The dashboard
is at <http://localhost:6791>.

## Environment

Set these in the Convex deployment (for cloud: `npx convex env set ...`; for
self-hosted: `npx convex env set` targets the deployment from `.env.local`).
The sync endpoints reject every request until `OKIDOKI_SYNC_SECRET` is set.

```bash
npx convex env set OKIDOKI_SYNC_SECRET "<same secret you paste into the app>"
npx convex env set OKIDOKI_SHARE_BASE_URL "https://your-hosted-panel.example.com"
```

The native app pushes snapshots to `http://127.0.0.1:3211/api/sync` with the
bearer secret from the macOS Keychain. The React control panel subscribes to
`dashboard.bootstrap` for real-time updates and `share.get` for read-only share
links.

## Security note

This is a single-user, local-first prototype. The sync endpoints use a bearer
secret; the Convex query used by the panel takes an `accountId`. Put Convex
Auth in front before exposing this to the public internet.
