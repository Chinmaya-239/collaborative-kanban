# AI service (optional, not implemented)

The assignment does not require an AI agent. `GET /api/boards/:id/summary` is already a safe, tenant-scoped,
read-only tool an agent could call. If added later: FastAPI service, Node forwards the *verified* tenant id,
allow-listed read-only tools only, no raw SQL.
