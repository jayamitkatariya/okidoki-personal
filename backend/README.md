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

The native app pushes its state to `http://127.0.0.1:3211/api/sync` with the
bearer secret saved on the Mac. Each sync runs as small batched mutations
(unchanged items are skipped), and the snapshot the panel loads is trimmed to fit
in one document; the full history stays on the Mac.

## Sign-in (Convex Auth)

Reading synced data requires a login: every query answers only the signed-in
owner of an account. Logins are email + password, stored in this deployment.
Set up the signing keys once per deployment:

```bash
npm run setup-auth -- http://127.0.0.1:5174
```

The argument is where the control panel runs. Then, in okidoki on the Mac, open
Settings › Sync login and sign in (or create a login). That links the Mac's
accounts to the login. To use the panel from a browser, build it with
`VITE_CONVEX_URL` pointing at this deployment's API URL (`:3210` locally) and
sign in with the same login.

Share links stay public by design: the random token is the permission.

## Security note

Without a login nothing synced is readable. The Mac still writes with the shared
`OKIDOKI_SYNC_SECRET`, and linking trusts that account ids are random UUIDs only
the Mac knows. Per-device tokens (pairing a Mac to a login) replace both next.
