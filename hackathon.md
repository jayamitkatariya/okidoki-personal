# Hackathon log

- **Project:** okidoki
- **Event:** Cal Hacks 13.0
- **What it does:** A macOS assistant that lives in the notch: shake the pointer, ask for something, approve what it does, and sync memory, runs, skills and team spaces across Macs.
- **Live app:** not deployed (native macOS app, `make app`)
- **Repo:** https://github.com/jayamitkatariya/okidoki
- **Frontend:** not deployed (React panel in `web/` is bundled into the app)
- **Convex deployment:** https://wonderful-rook-611.convex.cloud
- **Components:** none (no `convex/convex.config.ts`)
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, crons, file storage, realtime useQuery, paginated queries (server-side `.paginate` in `backend/convex/sync.ts`)
- **Auth:** Convex Auth (`@convex-dev/auth`, Password provider, `backend/convex/auth.ts`)
- **AI models:** claude-haiku-5-5 (default), claude-sonnet-5-5 (escalation/teach), claude-haiku-4-5, moss-minilm (memory), sonic-3 (voice)
- **Started:** 2026-10-24T05:41:45Z
- **Last updated:** 2026-10-25T13:07:43Z

## How we use Convex

- **Spaces chat with an agent worker.** `chat.messages` and `jobs.forSpace` are realtime `useQuery` subscriptions (`web/src/enterprise.tsx`): the Spaces page shows messages, run cards and approval prompts the moment a colleague's Mac writes them. Workers accept and report jobs via `/api/worker/*` HTTP actions (`backend/convex/http.ts`); a cron (`backend/convex/crons.ts`) reaps jobs whose worker stopped heart-beating.
- **Two-way sync across Macs.** `/api/sync` and `/api/pull` HTTP actions push and pull threads, memories, runs, skills and routines; versioned rows, tombstones and `by_account_version` indexes are in `backend/convex/schema.ts` and `sync.ts`, with cursor pagination for large pulls.
- **Sign-in and Mac pairing.** Convex Auth signs the panel in; the `devices.pair` action (`backend/convex/devices.ts`) issues a device token whose hash is stored in `deviceTokens`, and every `/api/*` route resolves it before touching an account.
- **Vault documents in file storage.** Uploads use `ctx.storage.generateUploadUrl()` and `ctx.storage.getUrl()` (`backend/convex/vault.ts`); the Vault page's file and credential lists update live.
- **Organizations, Team and shared skills.** Queries and mutations in `backend/convex/orgs.ts`, `spaces.ts` and `sharedSkills.ts` back the Team and Skills pages; roles, workers and published skills refresh live.
- **Live screens:** Home, Spaces, Team, Vault and Skills, via `useQuery` in `web/src/enterprise.tsx` and `cloud.tsx`. Tested with `convex-test` (`backend/tests/`).

## Log

- 2026-10-24 `0cd6620` Initial release — `backend/convex/schema.ts`, `Sources/`, `web/`
- 2026-10-24 `6f735e9` Convex Auth v1 — `backend/convex/auth.ts`, `web/src/cloud.tsx`
- 2026-10-24 `7ac5713` Organizations, Team page, Spaces chat — `backend/convex/orgs.ts`, `chat.ts`, `web/src/enterprise.tsx`
- 2026-10-24 `7a1ceee` Backend tests with convex-test — `backend/tests/enterprise.test.ts`
- 2026-10-24 `46843fa` Agent in space chat, Mac worker — `backend/convex/jobs.ts`, `SpaceWorker.swift`
- 2026-10-24 `7eb1075` Shared skills — `backend/convex/sharedSkills.ts`, `web/src/pages/SkillsPage.tsx`
- 2026-10-25 `f2ab3c5` Vault in file storage — `backend/convex/vault.ts`, `web/src/pages/VaultPage.tsx`
- 2026-10-25 `5f0b278` Versioned sync, tombstones — `backend/convex/sync.ts`, `backend/tests/sync.test.ts`
- 2026-10-25 `fbff1ca` Cron reaps lost jobs — `backend/convex/crons.ts`, `chat.ts`
- 2026-10-25 `46036af` Macs paired to logins, ownership checks — `backend/convex/devices.ts`, `http.ts`
- 2026-10-25 `339dd5c` Mac pairs via sync login — `Sources/OkidokiCore/Services/KeyStore.swift`
- 2026-10-25 `f60f1e4` Teach fixes, brain auto-restart — `brain/src/llm.ts`, `Sources/Okidoki/App/Sidecar.swift`
- 2026-10-25 `ec6fece` Drive pauses on user-only questions — `brain/src/computer2.ts`, `web/src/pages/RunsPage.tsx`
