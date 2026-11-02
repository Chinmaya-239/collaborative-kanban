# Branchboard: real-time collaborative Kanban (multi-organization, multi-tenant)

A real-time task board where users across organizations and their branches (tenants) collaborate with strict data isolation and live synchronization.

## Live demo

| Part | URL |
|---|---|
| Frontend (Vercel) | https://frontend-psi-rust-9lxkn0rpny.vercel.app/ |
| Backend + WebSocket (Render) | https://kanban-api-azkn.onrender.com (health check: `/api/health`) |
| Database | Neon PostgreSQL |

**Demo accounts** (password for all: `Password@123`)

| Email | Organization | Branch | Role |
|---|---|---|---|
| rahul@abc.test | ABC Technologies | all branches | Org Admin |
| priya@abc.test | ABC Technologies | Hyderabad | Tenant Admin |
| arjun@abc.test | ABC Technologies | Hyderabad | Member |
| sneha@abc.test | ABC Technologies | Bangalore | Tenant Admin |
| kiran@xyz.test | XYZ Solutions | Mumbai | Member |

**Try it in two minutes**
1. Open the site in two windows (one incognito) as Priya and Arjun. Both are in Hyderabad, so the header shows "2 online".
2. Drag a card in one window and watch it move in the other.
3. Edit the same task in both windows and save one after the other to see the conflict flow.
4. Press Ctrl/⌘+Z to undo a move, then open **Activity** to see the log.
5. Log in as Sneha and confirm she sees only Bangalore.

> The backend runs on a free Render instance that sleeps when idle. The first request after a pause can take 30 to 60 seconds. Open the site once and wait before testing.

## 1. Overview

Organizations (e.g. *ABC Technologies*) own branches called **tenants** (Hyderabad, Bangalore, Chennai). Each tenant has its own users, boards, columns, tasks and activity history. Employees collaborate on Kanban boards and see each other's changes live. A Hyderabad user can never read or receive anything from Bangalore.

## 2. Requirements coverage

| Requirement | Where |
|---|---|
| CRUD for organizations, tenants, boards, columns, tasks | `backend/src/routes/*` |
| Organization → tenant → board hierarchy | `prisma/schema.prisma`, `access.js` |
| Strict tenant isolation | §5 below; `smoke.js` proves it |
| RBAC (Org Admin, Tenant Admin, Member) | `access.js` `requireRole`, §6 |
| Real-time sync (WebSockets) | `realtime.js`, `docs/websocket-documentation.md` |
| Concurrency handling | version column + compare-and-swap, §8 |
| 8 tables, `tenant_id` on all business data | `schema.prisma`, `database/erd.md` |
| Efficient task ordering | fractional `position` (one-row writes), §8 |
| Org selector + tenant switcher | `Navbar.jsx` (options come from `/auth/me`) |
| Kanban + drag and drop, task panel | `Board.jsx` (dnd-kit), `TaskPanel.jsx` |
| Presence per tenant | `realtime.js`, `useRealtime.js` |
| Scoped WebSocket channels | rooms `tenant:<id>`, join authorized server-side |
| Optimistic UI | `useBoard.js` (move, delete) |
| Undo / redo | `useBoard.js` command stack, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z |
| Activity logs per tenant | `activity.js`, `ActivityPanel.jsx`, per-task history |
| Conflict resolution strategy | server 409 + client auto-merge / user choice, §8 |
| Edge cases | cross-tenant, cross-org, concurrent edits, drag conflicts, network recovery: §9 |

## 3. Stack and why

| Choice | Reason | Cost |
|---|---|---|
| PostgreSQL + Prisma | relational integrity, transactions, FKs, JSONB logs | Prisma has no native RLS; SQL provided in `database/rls.sql` |
| Express (modular: routes / access / realtime) | small, explicit | no DI framework |
| Socket.IO | rooms, ack callbacks, auto-reconnect | needs a Redis adapter to scale past one node |
| JWT (8h) + bcrypt | stateless identity | no server-side revocation. A removed member loses access on the next request because membership is re-checked each time |
| React + Vite + dnd-kit | accessible keyboard drag and drop | plain CSS, no component library |
| Token in `sessionStorage` | simple SPA flow | readable by XSS; an httpOnly cookie + CSRF protection is the hardening step |
| bcryptjs | pure JS, no native build | slower than native bcrypt |

Hosting: Vercel (frontend), Render (backend), Neon (PostgreSQL), GitHub (source).

## 4. Architecture

```
React (Vite) ──REST (JWT + X-Tenant-Id)──▶ Express ──Prisma──▶ PostgreSQL
     ▲                                        │
     └────── Socket.IO (JWT, tenant room) ◀───┘  emit AFTER commit
```

Flow of a drag: React updates the card locally → `PATCH /tasks/:id/move` → authenticate → verify tenant membership → transaction (read task, check version, compute position from DB neighbours, compare-and-swap update, activity row) → commit → `task:moved` to `tenant:<id>` only → other clients apply it.

## 5. Tenancy model

- **Organization** = the company; **tenant** = a branch and the isolation boundary. They are separate because one company owns many isolated workspaces, and org-level roles (Org Admin) span them.
- `memberships(user, organization, tenant?, role)`. `tenant_id = NULL` means org-level (only `ORG_ADMIN`). One user may have many memberships, with different roles per tenant.
- **How `tenant_id` is assigned:** never taken from a body. It comes from the verified `X-Tenant-Id` selection (`req.tenant.id`); body fields named `tenantId` are ignored.
- **How it is validated:** the `tenantScope` middleware loads the tenant and requires a membership for *this user*, in *that tenant's own organization*, or an org-level admin of it. Otherwise 403. The same function authorizes socket joins.
- **How isolation is enforced:** every query on tenant-owned tables includes `tenantId` (`where: { id, tenantId }`), and related ids (board, column, assignee) are checked to be in the same tenant. A foreign id returns 404, identical to "does not exist", so ids cannot be probed.
- **WebSockets:** one room per tenant; joining requires the DB check; broadcasts go to that room only.
- **Defence in depth:** optional PostgreSQL RLS (`database/rls.sql`) so the database refuses cross-tenant rows even if a query forgot its filter.

## 6. RBAC

Enforced in the backend (`requireRole`) on every route; the UI merely hides buttons. The full matrix is in `docs/api-documentation.md`.

| Role | Can do |
|---|---|
| Org Admin | Everything a Tenant Admin can, in every tenant of their organization; create tenants; manage organization members |
| Tenant Admin | Manage boards, columns and members of their tenant; assign tasks |
| Member | Create, edit and move any task; assign only themselves; delete only tasks they created |

## 7. Real-time

See `docs/websocket-documentation.md`. Writes use REST; the socket is an authorized fan-out channel. Presence is tracked per tenant and de-duplicated across tabs. Events are emitted only after the database commit.

## 8. Concurrency and ordering

- **Optimistic locking:** `tasks.version`. Writes are `UPDATE … WHERE id=? AND tenant_id=? AND version=?` followed by `version+1`, so two concurrent writers cannot both win. The loser gets **409** with the current task.
- **Edit conflicts (UI):** edits are made on a local draft. If a 409 occurs and the other person changed *different fields*, our changes are re-applied on the latest version automatically. If the *same field* changed, the user chooses "Keep my changes" or "Use their version". An incoming remote update never overwrites unsaved edits (a banner appears).
- **Drag conflicts:** the second mover gets 409, the board is refetched, and a toast explains. Two users reordering different cards both succeed because positions are computed server-side from current neighbours.
- **Ordering:** fractional ranks (`position` float). Inserting writes one row. If a gap collapses, the column is renumbered in the same transaction and clients refetch.
- **Edit vs delete:** the editor gets 404 `DELETED` and the panel closes with a message.
- **Idempotency:** `clientOpId` makes retried writes safe.
- **Undo/redo** is per client, built from inverse API calls with fresh versions. If someone changed the task meanwhile, undo is refused instead of overwriting. Undoing a delete recreates the task with a new id at the end of its column.

## 9. Edge-case handling

| Case | Behaviour |
|---|---|
| Cross-tenant ID access | 404 (REST); 403 if the header names a tenant you aren't in |
| Cross-organization | membership must be in the tenant's own org; separate tests for XYZ vs ABC |
| Forged room join | `tenant:join` ack `FORBIDDEN`, no events delivered |
| Network loss | "Reconnecting…" banner, auto-reconnect, re-join, full refetch |
| Stale optimistic move | reverted by refetching authoritative state |

## 10. Database

Eight tables: `organizations`, `tenants`, `users`, `memberships`, `boards`, `columns`, `tasks`, `activity_logs`. All business data carries `tenant_id`. The Prisma schema is in `backend/prisma/schema.prisma`, the migration in `backend/prisma/migrations/`, and the ER diagram (Mermaid) in `database/erd.md`.

## 11. Setup (local)

Requires Node 20+ and PostgreSQL 14+ (or a hosted Postgres such as Neon).

```bash
# 1. database
createdb collaborative_kanban      # or create it in pgAdmin

# 2. backend
cd backend
cp .env.example .env               # set DATABASE_URL and a long random JWT_SECRET
npm install
npx prisma migrate dev --name init # creates all 8 tables
npm run db:seed
npm run dev                        # http://localhost:5000  (GET /api/health)

# 3. frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                        # http://localhost:5173
```

**Environment variables**

| Where | Variable | Purpose |
|---|---|---|
| backend | `DATABASE_URL` | PostgreSQL connection string (use `?sslmode=require` on hosted databases) |
| backend | `JWT_SECRET` | long random value for signing tokens |
| backend | `JWT_EXPIRES_IN` | token lifetime, e.g. `8h` |
| backend | `PORT` | server port (provided by the host in production) |
| backend | `CORS_ORIGIN` | allowed frontend origin(s), comma-separated, no trailing slash |
| frontend | `VITE_API_URL` | backend base URL, without `/api` |

## 12. Deployment

| Part | Host | Notes |
|---|---|---|
| Database | Neon | connection string with `sslmode=require` |
| Backend | Render (Web Service) | root `backend`; build `npm install && npx prisma generate && npx prisma migrate deploy`; start `npm start` |
| Frontend | Vercel | root `frontend`; Vite preset; `VITE_API_URL` set to the Render URL; `vercel.json` rewrites all routes to `index.html` |

`CORS_ORIGIN` on Render must match the Vercel URL exactly. `VITE_API_URL` is baked in at build time, so redeploy the frontend after changing it. Run the seed only once on a fresh database, because it deletes existing data.

## 13. Testing

### Automated (29 checks)

`backend/scripts/smoke.js` runs against any deployment:

```bash
cd backend
API_URL=https://kanban-api-azkn.onrender.com npm run smoke
```

**Result against the deployed backend: 29 passed, 0 failed.**

| Area | What is verified |
|---|---|
| Authentication | 401 without a token; 401 with a tampered token; unauthenticated socket rejected |
| Tenant isolation | A user sees only their own tenants; a foreign tenant header gives 403; a task ID from another tenant gives 404 (PUT and DELETE blocked); a body `tenantId` is ignored; a missing tenant header gives 400 |
| Cross-organization | Priya (ABC) cannot use the Mumbai (XYZ) tenant and cannot join the Mumbai socket room |
| RBAC | A member cannot create boards or delete others' tasks; a tenant admin cannot create tenants; an org admin can |
| Concurrency | An update with the correct version succeeds and bumps the version; a stale update returns 409 with the current task; two simultaneous moves give exactly one winner and one 409; a retry with the same `clientOpId` is idempotent |
| WebSocket scoping | Authorized users join their own tenant rooms; forged joins are denied; `task:moved` reaches only the Hyderabad subscriber, not Bangalore or Mumbai |

### Manual

- **Real-time sync:** two browsers on the same board; create, edit, move and delete tasks; both update without a refresh.
- **Presence:** the online count and avatars update on connect and disconnect.
- **Undo/redo:** Ctrl/⌘+Z and Ctrl/⌘+Shift+Z reverse moves and edits.
- **Conflicts:** editing the same task in two windows triggers auto-merge (different fields) or a "keep mine / use theirs" choice (same field).
- **Isolation:** Sneha (Bangalore) sees nothing from Hyderabad.

### Not tested

No load or performance testing has been done.

## 14. Documentation

- API reference: `docs/api-documentation.md`
- WebSocket reference: `docs/websocket-documentation.md`
- ER diagram source: `database/erd.md`

## 15. Known limitations

- Not load-tested; single Node process (presence is in memory). Scaling out needs `@socket.io/redis-adapter` and Redis-backed presence.
- A member removed while connected keeps receiving room events until they reconnect (REST is blocked immediately).
- Undo/redo is per browser session, not shared.
- No refresh tokens or rate limiting; tokens live in `sessionStorage`.
- Task→column→tenant consistency is enforced in code; `rls.sql` shows the composite-key hardening.
- The free Render instance sleeps when idle, so the first request can be slow.
- The optional AI agent is not implemented (`ai-service/README.md`).

## 16. Future work

Redis adapter, refresh-token cookies, rate limiting, composite FKs + RLS enabled by default, soft deletes, CRDT text merging for descriptions, E2E browser tests (Playwright), an AI assistant on `/boards/:id/summary`.