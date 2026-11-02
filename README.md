# Branchboard: real-time collaborative Kanban (multi-organization, multi-tenant)

## 1. Overview
Organizations (e.g. *ABC Technologies*) own branches called **tenants** (Hyderabad, Bangalore, Chennai).
Each tenant has its own users, boards, columns, tasks and activity history. Employees collaborate on Kanban
boards and see each other's changes live. A Hyderabad user can never read or receive anything from Bangalore.

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

## 4. Architecture

```
React (Vite) ──REST (JWT + X-Tenant-Id)──▶ Express ──Prisma──▶ PostgreSQL
     ▲                                        │
     └────── Socket.IO (JWT, tenant room) ◀───┘  emit AFTER commit
```
Flow of a drag: React updates the card locally → `PATCH /tasks/:id/move` → authenticate → verify tenant
membership → transaction (read task, check version, compute position from DB neighbours, compare-and-swap
update, activity row) → commit → `task:moved` to `tenant:<id>` only → other clients apply it.

## 5. Tenancy model
* **Organization** = the company; **tenant** = a branch and the isolation boundary. They are separate
  because one company owns many isolated workspaces, and org-level roles (Org Admin) span them.
* `memberships(user, organization, tenant?, role)`. `tenant_id = NULL` means org-level (only `ORG_ADMIN`).
  One user may have many memberships, with different roles per tenant.
* **How `tenant_id` is assigned:** never taken from a body. It comes from the verified `X-Tenant-Id`
  selection (`req.tenant.id`); body fields named `tenantId` are ignored.
* **How it is validated:** `tenantScope` middleware loads the tenant and requires a membership for
  *this user*, in *that tenant's own organization*, or an org-level admin of it. Else 403. The same
  function authorizes socket joins.
* **How isolation is enforced:** every query on tenant-owned tables includes `tenantId`
  (`where: { id, tenantId }`), and related ids (board, column, assignee) are checked to be in the same tenant.
  A foreign id returns 404, identical to "does not exist", so ids cannot be probed.
* **WebSockets:** one room per tenant; join requires the DB check; broadcasts go to that room only.
* **Defence in depth:** optional PostgreSQL RLS (`database/rls.sql`) so the DB refuses cross-tenant rows
  even if a query forgot its filter.

## 6. RBAC
Enforced in the backend (`requireRole`) on every route; the UI merely hides buttons. Matrix in `docs/api-documentation.md`.
Members may create/edit/move any task, assign only themselves, and delete only tasks they created.
Org Admins act as tenant admins everywhere in their organization.

## 7. Real-time
See `docs/websocket-documentation.md`. Writes use REST, the socket is an authorized fan-out channel.
Presence is tracked per tenant and de-duplicated across tabs.

## 8. Concurrency and ordering
* **Optimistic locking:** `tasks.version`. Writes are `UPDATE … WHERE id=? AND tenant_id=? AND version=?`
  followed by `version+1`, so two concurrent writers cannot both win. Loser gets **409** with the current task.
* **Edit conflicts (UI):** edits are made on a local draft. If a 409 occurs and the other person changed
  *different fields*, our changes are re-applied on the latest version automatically. If the *same field*
  changed, the user chooses "Keep my changes" or "Use their version". An incoming remote update never
  overwrites unsaved edits (a banner appears).
* **Drag conflicts:** the second mover gets 409, the board is refetched, a toast explains. Two users
  reordering different cards both succeed because positions are computed server-side from current neighbours.
* **Ordering:** fractional ranks (`position` float). Inserting writes one row. If a gap collapses, the
  column is renumbered in the same transaction and clients refetch.
* **Edit vs delete:** the editor gets 404 `DELETED` and the panel closes with a message.
* **Idempotency:** `clientOpId` makes retried writes safe.
* **Undo/redo** is per client, built from inverse API calls with fresh versions. If someone changed the task meanwhile, undo is refused instead of overwriting. Undoing a delete recreates the task with a new id at the end of its column.

## 9. Edge-case handling

| Case | Behaviour |
|---|---|
| Cross-tenant ID access | 404 (REST); 403 if the header names a tenant you aren't in |
| Cross-organization | membership must be in the tenant's own org; separate tests for XYZ vs ABC |
| Forged room join | `tenant:join` ack `FORBIDDEN`, no events delivered |
| Network loss | "Reconnecting…" banner, auto-reconnect, re-join, full refetch |
| Stale optimistic move | reverted by refetching authoritative state |

## 10. Setup

Requires Node 20+, PostgreSQL 14+.

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
Seed users (password `Password@123`): `rahul@abc.test` (org admin), `priya@abc.test` (Hyderabad admin),
`arjun@abc.test` (Hyderabad member), `sneha@abc.test` (Bangalore admin), `kiran@xyz.test` (XYZ).

Environment variables: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `CORS_ORIGIN` (backend); `VITE_API_URL` (frontend).

## 11. Testing
* Automated: `cd backend && npm run smoke` (server running and seeded). Around 30 checks: 401s, cross-tenant and
  cross-org access by id, forged header, forged body `tenantId`, RBAC, optimistic-lock 409, simultaneous
  moves (exactly one wins), idempotent retry, socket room denial, and event delivery only to the right tenant.
* Manual demo (two browsers): log in as Priya and Arjun on Hyderabad → create/move/edit tasks and watch both
  update. Log in as Sneha in a third window: she sees nothing from Hyderabad. Stop the network in one
  window, change things in the other, restore, and watch it resync. Edit the same task's title in
  both windows to see the conflict flow.

## 12. Known limitations
* Not load-tested; single Node process (presence is in memory). Scaling out needs `@socket.io/redis-adapter`
  and Redis-backed presence.
* A member removed while connected keeps receiving room events until they reconnect (REST is blocked immediately).
* Undo/redo is per browser session, not shared.
* No refresh tokens or rate limiting; tokens live in `sessionStorage`.
* Task→column→tenant consistency is enforced in code; `rls.sql` shows the composite-key hardening.
* Optional AI agent not implemented (`ai-service/README.md`).

## 13. Future work
Redis adapter, refresh-token cookies, rate limiting, composite FKs + RLS enabled by default, soft deletes,
CRDT text merging for descriptions, E2E browser tests (Playwright), AI assistant on `/boards/:id/summary`.
