import { emitTenant } from './realtime.js';

const USER_SELECT = { select: { id: true, name: true } };

/** Write an activity row inside the caller's transaction. */
export const logActivity = (tx, { tenantId, userId, entityType, entityId, action, details }) =>
  tx.activityLog.create({
    data: { tenantId, userId, entityType, entityId, action, details: details ?? {} },
    include: { user: USER_SELECT },
  });

/** Idempotency: has this client operation id already been applied to this entity? */
export const findOp = (tx, tenantId, entityId, opId) =>
  opId
    ? tx.activityLog.findFirst({ where: { tenantId, entityId, details: { path: ['clientOpId'], equals: opId } } })
    : null;

export const publishActivity = (tenantId, log) => emitTenant(tenantId, 'activity:created', { log });
