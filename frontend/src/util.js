export const GAP = 1024;

/** Mirrors the server's midpoint ranking so optimistic ordering matches the committed order. */
export function computePosition(positions, at) {
  const prev = positions[at - 1];
  const next = positions[at];
  if (prev === undefined && next === undefined) return GAP;
  if (prev === undefined) return next / 2;
  if (next === undefined) return prev + GAP;
  return (prev + next) / 2;
}

export const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
export const initials = (name = '?') => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const dateInput = (iso) => (iso ? iso.slice(0, 10) : '');
export const isOverdue = (task, doneIds) => task.dueDate && new Date(task.dueDate) < new Date() && !doneIds.has(task.columnId);
export const timeAgo = (iso) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

export function describeLog(log, colName = () => 'a column') {
  const d = log.details || {};
  const what = log.entityType === 'task' ? `task “${d.title ?? ''}”`.replace(' “”', '') : log.entityType;
  switch (log.action) {
    case 'CREATED': return `created ${what}${d.name ? ` “${d.name}”` : ''}`;
    case 'MOVED': return `moved “${d.title}” from ${colName(d.fromColumnId)} to ${colName(d.toColumnId)}`;
    case 'UPDATED': {
      const keys = Object.keys(d.changes || d);
      return `updated ${log.entityType === 'task' ? 'a task' : log.entityType}${keys.length ? ` (${keys.filter((k) => k !== 'clientOpId').join(', ')})` : ''}`;
    }
    case 'DELETED': return `deleted ${what}`;
    default: return log.action.toLowerCase();
  }
}
