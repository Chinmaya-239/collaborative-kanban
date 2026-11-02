import { Router } from 'express';
import { prisma } from '../prisma.js';
import { pid, wrap } from '../errors.js';
import { authenticate } from '../auth.js';
import { tenantScope } from '../access.js';

const r = Router();
r.use(authenticate, tenantScope);

// GET /api/activity?limit=50&entityId=<uuid>
r.get('/', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const where = { tenantId: req.tenant.id };
  if (req.query.entityId) where.entityId = pid(String(req.query.entityId));
  const logs = await prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { user: { select: { id: true, name: true } } } });
  res.json({ logs });
}));

export default r;
