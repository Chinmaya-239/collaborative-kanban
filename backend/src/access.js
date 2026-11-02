/**
 * Authorization core. EVERYTHING that decides "may this user touch this tenant?"
 * lives here, and both the REST middleware and the Socket.IO handshake call it.
 */
import { prisma } from './prisma.js';
import { HttpError, isUuid, wrap } from './errors.js';

export const RANK = { MEMBER: 1, TENANT_ADMIN: 2, ORG_ADMIN: 3 };

/** Returns { tenant, role } if the user may access the tenant, otherwise null. */
export async function getTenantAccess(userId, tenantId) {
  if (!isUuid(tenantId) || !isUuid(userId)) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return null;
  const ms = await prisma.membership.findMany({
    where: {
      userId,
      organizationId: tenant.organizationId, // membership must belong to the tenant's own org
      OR: [{ tenantId }, { tenantId: null }],
    },
  });
  if (ms.some((m) => m.tenantId === null && m.role === 'ORG_ADMIN')) return { tenant, role: 'ORG_ADMIN' };
  const own = ms.find((m) => m.tenantId === tenantId);
  return own ? { tenant, role: own.role } : null;
}

/** Org-level access: ORG_ADMIN, or 'MEMBER' if the user belongs to any tenant of the org. */
export async function getOrgAccess(userId, organizationId) {
  if (!isUuid(organizationId)) return null;
  const ms = await prisma.membership.findMany({ where: { userId, organizationId } });
  if (!ms.length) return null;
  return ms.some((m) => m.tenantId === null && m.role === 'ORG_ADMIN') ? 'ORG_ADMIN' : 'MEMBER';
}

/** Everything the user may see: organizations with their authorized tenants and effective role. */
export async function listAuthorized(userId) {
  const ms = await prisma.membership.findMany({ where: { userId }, include: { organization: true, tenant: true } });
  const adminOrgs = new Set(ms.filter((m) => !m.tenantId && m.role === 'ORG_ADMIN').map((m) => m.organizationId));
  const orgs = new Map();
  for (const m of ms) {
    if (!orgs.has(m.organizationId)) {
      orgs.set(m.organizationId, {
        id: m.organizationId,
        name: m.organization.name,
        isOrgAdmin: adminOrgs.has(m.organizationId),
        tenants: [],
      });
    }
  }
  if (adminOrgs.size) {
    const all = await prisma.tenant.findMany({ where: { organizationId: { in: [...adminOrgs] } }, orderBy: { createdAt: 'asc' } });
    for (const t of all) orgs.get(t.organizationId).tenants.push({ id: t.id, name: t.name, role: 'ORG_ADMIN' });
  }
  for (const m of ms) {
    if (m.tenant && !adminOrgs.has(m.organizationId)) {
      orgs.get(m.organizationId).tenants.push({ id: m.tenantId, name: m.tenant.name, role: m.role });
    }
  }
  return [...orgs.values()];
}

/**
 * Express middleware: resolves the ACTIVE tenant from the X-Tenant-Id header and verifies,
 * against the database, that the authenticated user is a member. The header is only a
 * *selection*; it is never trusted as proof of access.
 */
export const tenantScope = wrap(async (req, _res, next) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) throw new HttpError(400, 'X-Tenant-Id header is required');
  const access = await getTenantAccess(req.user.id, tenantId);
  if (!access) throw new HttpError(403, 'You do not have access to this tenant');
  req.tenant = access.tenant;
  req.role = access.role;
  next();
});

/** Minimum-role guard, e.g. requireRole('TENANT_ADMIN') allows TENANT_ADMIN and ORG_ADMIN. */
export const requireRole = (min) => (req, _res, next) => {
  if ((RANK[req.role] || 0) < RANK[min]) return next(new HttpError(403, `Requires ${min} role`));
  next();
};
