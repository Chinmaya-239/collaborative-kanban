-- OPTIONAL defence in depth: PostgreSQL Row-Level Security.
-- The application already scopes every query by tenant_id; RLS makes the database refuse cross-tenant
-- rows even if a query forgets the filter. To use it, wrap each request's queries in a transaction that runs:
--     SELECT set_config('app.tenant_id', '<verified tenant uuid>', true);
-- and connect as a role that does NOT own the tables (owners bypass RLS unless FORCE is set).

ALTER TABLE boards        ENABLE ROW LEVEL SECURITY;
ALTER TABLE columns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON boards        USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON columns       USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON tasks         USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON activity_logs USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Integrity helper: a task's board/column must belong to the same tenant (also checked in application code).
ALTER TABLE columns ADD CONSTRAINT columns_board_tenant_unique UNIQUE (id, board_id, tenant_id);
