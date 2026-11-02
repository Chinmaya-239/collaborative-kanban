import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { HttpError, pid, wrap } from '../errors.js';
import { authenticate } from '../auth.js';
import { getTenantAccess, requireRole, tenantScope } from '../access.js';
import { findOp, logActivity, publishActivity } from '../activity.js';
import { emitTenant } from '../realtime.js';

const r = Router();
r.use(authenticate, tenantScope);

const GAP = 1024;
const opId = z.string().max(64).optional();
const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const date = z.string().datetime({ offset: true }).nullable();

const createSchema = z.object({
  boardId: z.string().uuid(),
  columnId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  priority: priority.optional(),
  dueDate: date.optional(),
  clientOpId: opId,
});
const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  priority: priority.optional(),
  dueDate: date.optional(),
  expectedVersion: z.number().int().min(1),
  clientOpId: opId,
}).refine((v) => Object.keys(v).some((k) => !['expectedVersion', 'clientOpId'].includes(k)), 'Nothing to update');
const moveSchema = z.object({
  columnId: z.string().uuid(),
  index: z.number().int().min(0), // final index among the destination column's OTHER tasks
  expectedVersion: z.number().int().min(1),
  clientOpId: opId,
});

const same = (a, b) => JSON.stringify(a instanceof Date ? a.toISOString() : a) === JSON.stringify(b instanceof Date ? b.toISOString() : b);
const diff = (before, after, keys) =>
  Object.fromEntries(keys.filter((k) => !same(before[k], after[k])).map((k) => [k, { from: before[k], to: after[k] }]));

/** Members may only assign to themselves / unassign. Assignee must be a member of THIS tenant. */
async function assertAssignable(req, assignedTo) {
  if (!assignedTo) return;
  if (req.role === 'MEMBER' && assignedTo !== req.user.id) throw new HttpError(403, 'Only tenant admins can assign tasks to other people');
  if (!(await getTenantAccess(assignedTo, req.tenant.id))) throw new HttpError(400, 'Assignee is not a member of this tenant');
}

const conflict = (current) => new HttpError(409, 'Task was modified by another user', { code: 'VERSION_CONFLICT', current });

// ---------- Create ----------
r.post('/', requireRole('MEMBER'), wrap(async (req, res) => {
  const { clientOpId, dueDate, ...data } = createSchema.parse(req.body);
  const tenantId = req.tenant.id;
  await assertAssignable(req, data.assignedTo);
  const { task, log } = await prisma.$transaction(async (tx) => {
    // board AND column must both belong to this tenant, and the column to this board
    const column = await tx.boardColumn.findFirst({ where: { id: data.columnId, boardId: data.boardId, tenantId } });
    if (!column) throw new HttpError(400, 'Column does not belong to this board');
    const last = await tx.task.aggregate({ where: { columnId: column.id, tenantId }, _max: { position: true } });
    const task = await tx.task.create({
      data: { ...data, tenantId, createdBy: req.user.id, dueDate: dueDate ? new Date(dueDate) : null, position: (last._max.position ?? 0) + GAP },
    });
    const log = await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'task', entityId: task.id, action: 'CREATED', details: { title: task.title, columnId: task.columnId, clientOpId } });
    return { task, log };
  });
  emitTenant(tenantId, 'task:created', { task, actorId: req.user.id, clientOpId });
  publishActivity(tenantId, log);
  res.status(201).json({ task });
}));

// ---------- List / Get ----------
r.get('/', wrap(async (req, res) => {
  const where = { tenantId: req.tenant.id };
  if (req.query.boardId) where.boardId = pid(String(req.query.boardId));
  if (req.query.columnId) where.columnId = pid(String(req.query.columnId));
  res.json({ tasks: await prisma.task.findMany({ where, orderBy: [{ columnId: 'asc' }, { position: 'asc' }], take: 1000 }) });
}));

r.get('/:id', wrap(async (req, res) => {
  const task = await prisma.task.findFirst({ where: { id: pid(req.params.id), tenantId: req.tenant.id } });
  if (!task) throw new HttpError(404, 'Task not found'); // identical response for "missing" and "belongs to another tenant"
  res.json({ task });
}));

// ---------- Update (optimistic locking) ----------
r.put('/:id', requireRole('MEMBER'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const { expectedVersion, clientOpId, ...fields } = updateSchema.parse(req.body);
  const tenantId = req.tenant.id;
  if ('assignedTo' in fields) await assertAssignable(req, fields.assignedTo);
  if (fields.dueDate !== undefined) fields.dueDate = fields.dueDate ? new Date(fields.dueDate) : null;

  const out = await prisma.$transaction(async (tx) => {
    if (await findOp(tx, tenantId, id, clientOpId)) return { task: await tx.task.findFirst({ where: { id, tenantId } }), replay: true };
    const before = await tx.task.findFirst({ where: { id, tenantId } });
    if (!before) throw new HttpError(404, 'Task not found (it may have been deleted)', { code: 'DELETED' });
    // Compare-and-swap: the WHERE clause includes the version, so two concurrent writers can never both succeed.
    const { count } = await tx.task.updateMany({ where: { id, tenantId, version: expectedVersion }, data: { ...fields, version: { increment: 1 } } });
    if (!count) throw conflict(await tx.task.findFirst({ where: { id, tenantId } }));
    const task = await tx.task.findFirst({ where: { id, tenantId } });
    const log = await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'task', entityId: id, action: 'UPDATED', details: { changes: diff(before, task, Object.keys(fields)), clientOpId } });
    return { task, log };
  });
  if (!out.replay) {
    emitTenant(tenantId, 'task:updated', { task: out.task, actorId: req.user.id, clientOpId });
    publishActivity(tenantId, out.log);
  }
  res.json({ task: out.task });
}));

// ---------- Move (drag & drop) ----------
r.patch('/:id/move', requireRole('MEMBER'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const { columnId, index, expectedVersion, clientOpId } = moveSchema.parse(req.body);
  const tenantId = req.tenant.id;

  const out = await prisma.$transaction(async (tx) => {
    if (await findOp(tx, tenantId, id, clientOpId)) return { task: await tx.task.findFirst({ where: { id, tenantId } }), replay: true };
    const task = await tx.task.findFirst({ where: { id, tenantId } });
    if (!task) throw new HttpError(404, 'Task not found (it may have been deleted)', { code: 'DELETED' });
    if (task.version !== expectedVersion) throw conflict(task);
    const dest = await tx.boardColumn.findFirst({ where: { id: columnId, tenantId, boardId: task.boardId } });
    if (!dest) throw new HttpError(400, 'Destination column is not on this task\'s board');

    // Server-authoritative ordering: compute the position from the *current* neighbours in the DB.
    const siblings = await tx.task.findMany({ where: { tenantId, columnId, id: { not: id } }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
    const at = Math.min(index, siblings.length);
    const prev = siblings[at - 1]?.position;
    const next = siblings[at]?.position;
    let position = prev === undefined && next === undefined ? GAP : prev === undefined ? next / 2 : next === undefined ? prev + GAP : (prev + next) / 2;

    let rebalanced = false;
    if ((prev !== undefined && position <= prev) || (next !== undefined && position >= next)) {
      // gap exhausted by repeated midpoint inserts: renumber the column once
      rebalanced = true;
      for (let i = 0; i < siblings.length; i++) {
        await tx.task.update({ where: { id: siblings[i].id }, data: { position: (i + (i >= at ? 2 : 1)) * GAP } });
      }
      position = (at + 1) * GAP;
    }

    const { count } = await tx.task.updateMany({ where: { id, tenantId, version: expectedVersion }, data: { columnId, position, version: { increment: 1 } } });
    if (!count) throw conflict(await tx.task.findFirst({ where: { id, tenantId } }));
    const moved = await tx.task.findFirst({ where: { id, tenantId } });
    const log = await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'task', entityId: id, action: 'MOVED', details: { title: moved.title, fromColumnId: task.columnId, toColumnId: columnId, clientOpId } });
    return { task: moved, log, rebalanced, fromColumnId: task.columnId };
  });
  if (!out.replay) {
    // Broadcast strictly AFTER commit so clients never see state that could still roll back
    emitTenant(tenantId, 'task:moved', { task: out.task, fromColumnId: out.fromColumnId, rebalanced: out.rebalanced, actorId: req.user.id, clientOpId });
    publishActivity(tenantId, out.log);
  }
  res.json({ task: out.task });
}));

// ---------- Delete ----------
r.delete('/:id', requireRole('MEMBER'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const tenantId = req.tenant.id;
  const expected = req.query.expectedVersion !== undefined ? Number(req.query.expectedVersion) : undefined;
  if (expected !== undefined && !Number.isInteger(expected)) throw new HttpError(400, 'expectedVersion must be an integer');

  const out = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id, tenantId } });
    if (!task) throw new HttpError(404, 'Task not found', { code: 'DELETED' });
    if (req.role === 'MEMBER' && task.createdBy !== req.user.id) throw new HttpError(403, 'Members can only delete tasks they created');
    const { count } = await tx.task.deleteMany({ where: { id, tenantId, ...(expected !== undefined ? { version: expected } : {}) } });
    if (!count) throw conflict(await tx.task.findFirst({ where: { id, tenantId } }));
    const log = await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'task', entityId: id, action: 'DELETED', details: { title: task.title } });
    return { task, log };
  });
  emitTenant(tenantId, 'task:deleted', { taskId: id, columnId: out.task.columnId, boardId: out.task.boardId, actorId: req.user.id });
  publishActivity(tenantId, out.log);
  res.status(204).end();
}));

export default r;
