# REST API

Base URL `http://localhost:5000/api`. JSON in/out.

**Auth:** `Authorization: Bearer <JWT>` on everything except register/login/health.
**Tenant scope:** boards, columns, tasks, activity and `/tenants/:id/members` additionally need
`X-Tenant-Id: <tenant uuid>`. The header only *selects* the tenant. The server checks the caller's
membership in the database on every request.

## Status codes

| Code | Meaning |
|---|---|
| 200/201/204 | success |
| 400 | validation failed (`issues[]`), missing `X-Tenant-Id`, or a foreign id inside a body |
| 401 | missing/invalid/expired token |
| 403 | authenticated but not a member of the tenant, or role too low |
| 404 | not found. **Also returned for another tenant's resource id**, so ids cannot be probed |
| 409 | `VERSION_CONFLICT` (body has `current`), `DUPLICATE`, `COLUMN_NOT_EMPTY` |

## Roles

| Role | Scope | Can |
|---|---|---|
| ORG_ADMIN | org-level membership (`tenant_id` NULL) | everything in all tenants of the org; create/delete tenants; add org admins |
| TENANT_ADMIN | one tenant | boards, columns, members, assign tasks to anyone, delete any task, rename tenant |
| MEMBER | one tenant | view; create/edit/move tasks; assign tasks to self only; delete only tasks they created |

A user can have different roles in different tenants, and can belong to several organizations.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /auth/register | `{name,email,password(≥8)}` | 201 `{user,token}`; 409 if email taken |
| POST | /auth/login | `{email,password}` | 200 `{user,token}`; 401 generic message |
| GET | /auth/me | | `{user, organizations:[{id,name,isOrgAdmin,tenants:[{id,name,role}]}]}`: the only source for selectors |

## Organizations (no tenant header)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | /organizations | any user | creator becomes ORG_ADMIN |
| GET | /organizations | any | only orgs the user belongs to |
| GET | /organizations/:id | member of org | 404 for outsiders |
| PUT | /organizations/:id | ORG_ADMIN | `{name}` |
| DELETE | /organizations/:id | ORG_ADMIN | cascades |
| POST | /organizations/:id/admins | ORG_ADMIN | `{email}` |

## Tenants / branches (no tenant header)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | /tenants | ORG_ADMIN of `organizationId` | `{organizationId,name}` |
| GET | /tenants?organizationId= | any | authorized tenants only |
| GET | /tenants/:id | member | |
| PUT | /tenants/:id | TENANT_ADMIN+ | `{name}` |
| DELETE | /tenants/:id | ORG_ADMIN | |
| GET | /tenants/:id/members | member | includes inherited org admins (`inherited:true`) |
| POST | /tenants/:id/members | TENANT_ADMIN+ | `{email, role: TENANT_ADMIN\|MEMBER}` (upsert) |
| DELETE | /tenants/:id/members/:userId | TENANT_ADMIN+ | |

## Boards / columns (tenant header required)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | /boards | TENANT_ADMIN | `{name,description?}`, creates To Do / In Progress / Testing / Done |
| GET | /boards | member | |
| GET | /boards/:id | member | board + ordered columns + ordered tasks (initial load and reconnect resync) |
| PUT / DELETE | /boards/:id | TENANT_ADMIN | |
| GET | /boards/:id/columns | member | |
| GET | /boards/:id/summary | member | `{total, byColumn, overdue, completionRate}` |
| POST | /columns | TENANT_ADMIN | `{boardId,name,position?}` |
| PUT | /columns/:id | TENANT_ADMIN | `{name?,position?}` |
| DELETE | /columns/:id | TENANT_ADMIN | 409 `COLUMN_NOT_EMPTY` if it has tasks |

## Tasks (tenant header required)

| Method | Path | Role | Body |
|---|---|---|---|
| POST | /tasks | MEMBER+ | `{boardId,columnId,title,description?,assignedTo?,priority?,dueDate?,clientOpId?}` → 201 `{task}` (appended at end) |
| GET | /tasks?boardId=&columnId= | MEMBER+ | ordered by position |
| GET | /tasks/:id | MEMBER+ | |
| PUT | /tasks/:id | MEMBER+ | any of `title,description,assignedTo,priority,dueDate` **plus required `expectedVersion`** |
| PATCH | /tasks/:id/move | MEMBER+ | `{columnId, index, expectedVersion, clientOpId?}` |
| DELETE | /tasks/:id?expectedVersion= | MEMBER+ (members: own tasks only) | 204 |

**Move.** `index` is the final index among the destination column's *other* tasks. The server computes
the new `position` from the current neighbours (midpoint), so clients never choose ranks. If the gap
between two neighbours is exhausted, the column is renumbered inside the same transaction
(`rebalanced:true` in the event).

**Conflict response (409):**
```json
{ "error": "Task was modified by another user", "code": "VERSION_CONFLICT",
  "current": { "id": "…", "version": 5, "title": "…", "…": "…" } }
```
A task deleted by someone else returns `404` with `code: "DELETED"`.

**Idempotency.** If `clientOpId` was already applied to that task, the call returns the current task
instead of re-applying or conflicting. This makes retries after a dropped response safe.

## Activity

`GET /activity?limit=50&entityId=<uuid>`: newest first, tenant-scoped.
`{logs:[{id,userId,user:{id,name},entityType,entityId,action,details,createdAt}]}`

## Example: move a task

```bash
curl -X PATCH http://localhost:5000/api/tasks/$TASK/move \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT" -H "Content-Type: application/json" \
  -d '{"columnId":"<dest column>","index":0,"expectedVersion":3}'
```
