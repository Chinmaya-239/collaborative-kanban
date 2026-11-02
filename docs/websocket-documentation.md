# WebSocket (Socket.IO) protocol

Endpoint: same origin as the API (`http://localhost:5000`).

## Connect and authenticate

```js
const socket = io(API_URL, { auth: { token: JWT } });
```
The handshake verifies the JWT and loads the user. A bad or expired token gives `connect_error: unauthorized`.
A connected socket is **in no room** and receives no business events yet.

## Join a tenant room

```js
socket.emit('tenant:join', { tenantId }, (ack) => { /* ack = { ok, role, presence } | { ok:false, error } */ });
```
The server calls the same `getTenantAccess()` used by REST, which checks the database for a membership of
the user in that tenant, or an org-level ORG_ADMIN membership of the tenant's own organization.
Failure gives `{ok:false,error:'FORBIDDEN'}` and the socket is **not** joined. A socket sits in at most
one tenant room: joining another leaves the first. Clients cannot join arbitrary room names.
Room name is `tenant:<uuid>`. `tenant:leave` leaves explicitly.

## Server → client events

All are emitted only to the tenant's room, and only **after** the DB transaction commits.

| Event | Payload | When |
|---|---|---|
| `task:created` | `{task, actorId, clientOpId}` | task created |
| `task:updated` | `{task, actorId, clientOpId}` | fields edited (version bumped) |
| `task:moved` | `{task, fromColumnId, rebalanced, actorId, clientOpId}` | moved or reordered. If `rebalanced`, refetch the board |
| `task:deleted` | `{taskId, columnId, boardId, actorId}` | deleted |
| `board:updated` | `{boardId, actorId}` | board or column created/renamed/reordered/deleted. Refetch |
| `board:deleted` | `{boardId, actorId}` | |
| `activity:created` | `{log}` | every audited action |
| `members:updated` | `{}` | membership changed |
| `presence:update` | `{users:[{id,name}]}` | full snapshot of who is online |
| `presence:online` / `presence:offline` | `{user}` | a user's first tab joined / last tab left |

Events carry the full task with its `version`; clients apply an event only if `event.version >= local.version`,
so late or duplicated events cannot roll state backwards.

## Presence

Tracked per tenant as `userId → set of socket ids`. A user with two tabs stays online until both close.
Disconnects (including network loss, detected by Socket.IO's ping timeout) remove the socket and broadcast a new snapshot.

## Reconnection

1. The client shows "Reconnecting…" on `disconnect`.
2. Socket.IO reconnects with exponential backoff, re-sending the same `auth.token`.
3. On every `connect` the client emits `tenant:join` again. Membership is re-verified, so a user removed meanwhile gets `FORBIDDEN`.
4. After a successful join the client **refetches `GET /boards/:id`**. Events missed while offline are never replayed; the database is the source of truth.

## Writes go through REST, not the socket

Mutations use REST so they share validation, RBAC, transactions and versioning. The socket is a
one-way, authorized fan-out channel (plus join/leave), which keeps the authorization surface small.
