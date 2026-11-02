import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { HttpError, pid, wrap } from '../errors.js';
import { authenticate } from '../auth.js';
import { requireRole, tenantScope } from '../access.js';
import { logActivity, publishActivity } from '../activity.js';
import { emitTenant } from '../realtime.js';

export const boardRouter = Router();
export const columnRouter = Router();
for (const r of [boardRouter, columnRouter]) r.use(authenticate, tenantScope); // every route is tenant-scoped

const boardSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional() });
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Testing', 'Done'];

// ---------- Boards ----------
boardRouter.post('/', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const body = boardSchema.parse(req.body);
  const tenantId = req.tenant.id;
  const { board, log } = await prisma.$transaction(async (tx) => {
    const board = await tx.board.create({
      data: { ...body, tenantId, organizationId: req.tenant.organizationId, createdBy: req.user.id },
    });
    await tx.boardColumn.createMany({ data: DEFAULT_COLUMNS.map((name, i) => ({ name, position: i + 1, boardId: board.id, tenantId })) });
    const log = await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'board', entityId: board.id, action: 'CREATED', details: { name: board.name } });
    return { board, log };
  });
  emitTenant(tenantId, 'board:updated', { boardId: board.id, actorId: req.user.id });
  publishActivity(tenantId, log);
  res.status(201).json({ board });
}));

boardRouter.get('/', wrap(async (req, res) => {
  const boards = await prisma.board.findMany({
    where: { tenantId: req.tenant.id },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { tasks: true } } },
  });
  res.json({ boards });
}));

// Full board payload (board + ordered columns + ordered tasks): used for initial load and resync after reconnect
boardRouter.get('/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const board = await prisma.board.findFirst({
    where: { id, tenantId: req.tenant.id },
    include: {
      columns: { orderBy: { position: 'asc' } },
      tasks: { orderBy: [{ columnId: 'asc' }, { position: 'asc' }] },
    },
  });
  if (!board) throw new HttpError(404, 'Board not found');
  res.json({ board });
}));

boardRouter.put('/:id', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const body = boardSchema.partial().parse(req.body);
  const tenantId = req.tenant.id;
  const board = await prisma.$transaction(async (tx) => {
    const { count } = await tx.board.updateMany({ where: { id, tenantId }, data: body });
    if (!count) throw new HttpError(404, 'Board not found');
    await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'board', entityId: id, action: 'UPDATED', details: body });
    return tx.board.findFirst({ where: { id, tenantId } });
  });
  emitTenant(tenantId, 'board:updated', { boardId: id, actorId: req.user.id });
  res.json({ board });
}));

boardRouter.delete('/:id', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const tenantId = req.tenant.id;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.board.deleteMany({ where: { id, tenantId } });
    if (!count) throw new HttpError(404, 'Board not found');
    await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'board', entityId: id, action: 'DELETED', details: {} });
  });
  emitTenant(tenantId, 'board:deleted', { boardId: id, actorId: req.user.id });
  res.status(204).end();
}));

boardRouter.get('/:id/columns', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const board = await prisma.board.findFirst({ where: { id, tenantId: req.tenant.id }, select: { id: true } });
  if (!board) throw new HttpError(404, 'Board not found');
  res.json({ columns: await prisma.boardColumn.findMany({ where: { boardId: id, tenantId: req.tenant.id }, orderBy: { position: 'asc' } }) });
}));

// Aggregated stats (also what a read-only AI assistant tool would call)
boardRouter.get('/:id/summary', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const tenantId = req.tenant.id;
  const board = await prisma.board.findFirst({ where: { id, tenantId }, include: { columns: { orderBy: { position: 'asc' } } } });
  if (!board) throw new HttpError(404, 'Board not found');
  const counts = await prisma.task.groupBy({ by: ['columnId'], where: { boardId: id, tenantId }, _count: { _all: true } });
  const overdue = await prisma.task.count({ where: { boardId: id, tenantId, dueDate: { lt: new Date() }, column: { name: { not: 'Done' } } } });
  const byColumn = board.columns.map((c) => ({ column: c.name, count: counts.find((x) => x.columnId === c.id)?._count._all ?? 0 }));
  const total = byColumn.reduce((s, c) => s + c.count, 0);
  const done = byColumn.find((c) => c.column === 'Done')?.count ?? 0;
  res.json({ total, byColumn, overdue, completionRate: total ? Math.round((done / total) * 100) : 0 });
}));

// ---------- Columns ----------
const colCreate = z.object({ boardId: z.string().uuid(), name: z.string().trim().min(1).max(100), position: z.number().int().min(1).optional() });
const colUpdate = z.object({ name: z.string().trim().min(1).max(100).optional(), position: z.number().int().min(1).optional() }).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

columnRouter.post('/', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const { boardId, name, position } = colCreate.parse(req.body);
  const tenantId = req.tenant.id;
  const column = await prisma.$transaction(async (tx) => {
    const board = await tx.board.findFirst({ where: { id: boardId, tenantId } });
    if (!board) throw new HttpError(404, 'Board not found');
    const max = await tx.boardColumn.aggregate({ where: { boardId, tenantId }, _max: { position: true } });
    const c = await tx.boardColumn.create({ data: { boardId, tenantId, name, position: position ?? (max._max.position ?? 0) + 1 } });
    await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'column', entityId: c.id, action: 'CREATED', details: { name, boardId } });
    return c;
  });
  emitTenant(tenantId, 'board:updated', { boardId, actorId: req.user.id });
  res.status(201).json({ column });
}));

columnRouter.put('/:id', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const data = colUpdate.parse(req.body);
  const tenantId = req.tenant.id;
  const column = await prisma.$transaction(async (tx) => {
    const col = await tx.boardColumn.findFirst({ where: { id, tenantId } });
    if (!col) throw new HttpError(404, 'Column not found');
    await tx.boardColumn.update({ where: { id }, data });
    await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'column', entityId: id, action: 'UPDATED', details: data });
    return tx.boardColumn.findFirst({ where: { id, tenantId } });
  });
  emitTenant(tenantId, 'board:updated', { boardId: column.boardId, actorId: req.user.id });
  res.json({ column });
}));

columnRouter.delete('/:id', requireRole('TENANT_ADMIN'), wrap(async (req, res) => {
  const id = pid(req.params.id);
  const tenantId = req.tenant.id;
  const boardId = await prisma.$transaction(async (tx) => {
    const col = await tx.boardColumn.findFirst({ where: { id, tenantId } });
    if (!col) throw new HttpError(404, 'Column not found');
    const tasks = await tx.task.count({ where: { columnId: id, tenantId } });
    if (tasks) throw new HttpError(409, 'Move or delete the tasks in this column first', { code: 'COLUMN_NOT_EMPTY' });
    await tx.boardColumn.delete({ where: { id } });
    await logActivity(tx, { tenantId, userId: req.user.id, entityType: 'column', entityId: id, action: 'DELETED', details: { name: col.name } });
    return col.boardId;
  });
  emitTenant(tenantId, 'board:updated', { boardId, actorId: req.user.id });
  res.status(204).end();
}));
