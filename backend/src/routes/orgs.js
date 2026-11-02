import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { HttpError, pid, wrap } from '../errors.js';
import { authenticate } from '../auth.js';
import { getOrgAccess, getTenantAccess, listAuthorized, RANK } from '../access.js';
import { emitTenant } from '../realtime.js';

export const orgRouter = Router();
export const tenantRouter = Router();
orgRouter.use(authenticate);
tenantRouter.use(authenticate);

const nameSchema = z.object({ name: z.string().trim().min(1).max(200) });
const emailSchema = z.object({ email: z.string().trim().toLowerCase().email() });

async function requireOrg(req, orgId, min = 'MEMBER') {
  const role = await getOrgAccess(req.user.id, orgId);
  // 404 (not 403) so that outsiders cannot probe which organizations exist
  if (!role || RANK[role] < RANK[min]) throw new HttpError(role ? 403 : 404, role ? 'Requires ORG_ADMIN role' : 'Not found');
  return role;
}

// ---------- Organizations ----------
orgRouter.post('/', wrap(async (req, res) => {
  const { name } = nameSchema.parse(req.body);
  const org = await prisma.$transaction(async (tx) => {
    const o = await tx.organization.create({ data: { name } });
    await tx.membership.create({ data: { userId: req.user.id, organizationId: o.id, tenantId: null, role: 'ORG_ADMIN' } });
    return o;
  });
  res.status(201).json({ organization: org });
}));

orgRouter.get('/', wrap(async (req, res) => {
  const orgs = await listAuthorized(req.user.id);
  res.json({ organizations: orgs });
}));

orgRouter.get('/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const role = await requireOrg(req, id);
  const org = await prisma.organization.findUnique({ where: { id } });
  const orgs = await listAuthorized(req.user.id);
  res.json({ organization: org, role, tenants: orgs.find((o) => o.id === id)?.tenants ?? [] });
}));

orgRouter.put('/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  await requireOrg(req, id, 'ORG_ADMIN');
  const { name } = nameSchema.parse(req.body);
  res.json({ organization: await prisma.organization.update({ where: { id }, data: { name } }) });
}));

orgRouter.delete('/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  await requireOrg(req, id, 'ORG_ADMIN');
  await prisma.organization.delete({ where: { id } }); // cascades to every tenant-owned row
  res.status(204).end();
}));

// Promote an existing user to organization admin (org-level membership, tenant_id = NULL)
orgRouter.post('/:id/admins', wrap(async (req, res) => {
  const id = pid(req.params.id);
  await requireOrg(req, id, 'ORG_ADMIN');
  const { email } = emailSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(404, 'No registered user with that email');
  const existing = await prisma.membership.findFirst({ where: { userId: user.id, organizationId: id, tenantId: null } });
  if (!existing) await prisma.membership.create({ data: { userId: user.id, organizationId: id, tenantId: null, role: 'ORG_ADMIN' } });
  res.status(201).json({ ok: true });
}));

// ---------- Tenants (branches) ----------
tenantRouter.post('/', wrap(async (req, res) => {
  const { organizationId, name } = z.object({ organizationId: z.string().uuid(), name: nameSchema.shape.name }).parse(req.body);
  await requireOrg(req, organizationId, 'ORG_ADMIN');
  res.status(201).json({ tenant: await prisma.tenant.create({ data: { organizationId, name } }) });
}));

tenantRouter.get('/', wrap(async (req, res) => {
  const orgs = await listAuthorized(req.user.id);
  const orgId = req.query.organizationId;
  const tenants = orgs.filter((o) => !orgId || o.id === orgId).flatMap((o) => o.tenants.map((t) => ({ ...t, organizationId: o.id })));
  res.json({ tenants });
}));

async function tenantAccess(req, min = 'MEMBER') {
  const id = pid(req.params.id);
  const access = await getTenantAccess(req.user.id, id);
  if (!access) throw new HttpError(404, 'Not found');
  if (RANK[access.role] < RANK[min]) throw new HttpError(403, `Requires ${min} role`);
  return { id, ...access };
}

tenantRouter.get('/:id', wrap(async (req, res) => {
  const { tenant, role } = await tenantAccess(req);
  res.json({ tenant, role });
}));

tenantRouter.put('/:id', wrap(async (req, res) => {
  const { id } = await tenantAccess(req, 'TENANT_ADMIN');
  const { name } = nameSchema.parse(req.body);
  res.json({ tenant: await prisma.tenant.update({ where: { id }, data: { name } }) });
}));

tenantRouter.delete('/:id', wrap(async (req, res) => {
  const { id } = await tenantAccess(req, 'ORG_ADMIN');
  await prisma.tenant.delete({ where: { id } });
  res.status(204).end();
}));

// ---------- Tenant membership management ----------
tenantRouter.get('/:id/members', wrap(async (req, res) => {
  const { id, tenant } = await tenantAccess(req);
  const rows = await prisma.membership.findMany({
    where: { organizationId: tenant.organizationId, OR: [{ tenantId: id }, { tenantId: null }] },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const byUser = new Map();
  for (const m of rows) {
    const cur = byUser.get(m.userId);
    const inherited = m.tenantId === null;
    if (!cur || RANK[m.role] > RANK[cur.role]) byUser.set(m.userId, { ...m.user, role: m.role, inherited });
  }
  res.json({ members: [...byUser.values()] });
}));

const memberSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['TENANT_ADMIN', 'MEMBER']) });

tenantRouter.post('/:id/members', wrap(async (req, res) => {
  const { id, tenant } = await tenantAccess(req, 'TENANT_ADMIN');
  const { email, role } = memberSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(404, 'No registered user with that email');
  const existing = await prisma.membership.findFirst({ where: { userId: user.id, organizationId: tenant.organizationId, tenantId: id } });
  const m = existing
    ? await prisma.membership.update({ where: { id: existing.id }, data: { role } })
    : await prisma.membership.create({ data: { userId: user.id, organizationId: tenant.organizationId, tenantId: id, role } });
  emitTenant(id, 'members:updated', {});
  res.status(existing ? 200 : 201).json({ membership: m });
}));

tenantRouter.delete('/:id/members/:userId', wrap(async (req, res) => {
  const { id } = await tenantAccess(req, 'TENANT_ADMIN');
  const userId = pid(req.params.userId);
  const { count } = await prisma.membership.deleteMany({ where: { userId, tenantId: id } });
  if (!count) throw new HttpError(404, 'Membership not found');
  emitTenant(id, 'members:updated', {});
  res.status(204).end();
}));
