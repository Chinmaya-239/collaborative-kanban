import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import { computePosition, uid } from '../util.js';
import { useApp } from '../context/AppContext.jsx';

/**
 * Board state: server snapshot + live socket events + optimistic mutations + undo/redo.
 * The server is authoritative: every response/event is applied only if its version is not older than ours.
 */
export function useBoard(boardId, tenantId, resyncKey) {
  const { toast, errMsg } = useApp();
  const [board, setBoard] = useState(null);
  const [columns, setColumns] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [gone, setGone] = useState(false);
  const [, bump] = useState(0);
  const tasksRef = useRef([]);
  const seq = useRef(0);
  const history = useRef({ undo: [], redo: [] });
  tasksRef.current = tasks;

  const load = useCallback(async () => {
    if (!boardId) return;
    const mine = ++seq.current; // ignore out-of-order responses
    try {
      const { data } = await api.get(`/boards/${boardId}`);
      if (mine !== seq.current) return;
      setBoard(data.board); setColumns(data.board.columns); setTasks(data.board.tasks); setGone(false);
    } catch (e) {
      if (e.response?.status === 404) setGone(true); else toast(errMsg(e), 'error');
    } finally { if (mine === seq.current) setLoading(false); }
  }, [boardId, toast, errMsg]);

  useEffect(() => { setBoard(null); setColumns([]); setTasks([]); setLoading(!!boardId); history.current = { undo: [], redo: [] }; }, [boardId]);
  useEffect(() => { load(); }, [load, resyncKey]);

  const upsert = useCallback((t) => setTasks((prev) => {
    const i = prev.findIndex((x) => x.id === t.id);
    if (i < 0) return [...prev, t];
    if (prev[i].version > t.version) return prev; // stale event/response: keep the newer copy
    const next = prev.slice(); next[i] = t; return next;
  }), []);

  useEffect(() => {
    const s = getSocket();
    if (!s || !boardId) return undefined;
    const mine = (t) => t && t.boardId === boardId && t.tenantId === tenantId;
    const on = {
      'task:created': ({ task }) => mine(task) && upsert(task),
      'task:updated': ({ task }) => mine(task) && upsert(task),
      'task:moved': ({ task, rebalanced }) => { if (!mine(task)) return; upsert(task); if (rebalanced) load(); },
      'task:deleted': ({ taskId, boardId: b }) => b === boardId && setTasks((p) => p.filter((t) => t.id !== taskId)),
      'board:updated': ({ boardId: b }) => b === boardId && load(),
      'board:deleted': ({ boardId: b }) => b === boardId && setGone(true),
    };
    Object.entries(on).forEach(([e, h]) => s.on(e, h));
    return () => Object.entries(on).forEach(([e, h]) => s.off(e, h));
  }, [boardId, tenantId, upsert, load]);

  const byColumn = useMemo(() => {
    const m = Object.fromEntries(columns.map((c) => [c.id, []]));
    tasks.forEach((t) => m[t.columnId]?.push(t));
    Object.values(m).forEach((l) => l.sort((a, b) => a.position - b.position));
    return m;
  }, [columns, tasks]);

  const fail = useCallback((e, resync = true) => {
    const code = e.response?.data?.code;
    if (e.response?.status === 409) toast('Someone else changed this task first — the board was refreshed.', 'warn');
    else if (code === 'DELETED') toast('That task was deleted by someone else.', 'warn');
    else toast(errMsg(e), 'error');
    if (resync) load();
  }, [toast, errMsg, load]);

  // ---------- undo / redo ----------
  const record = (cmd) => { history.current.undo.push(cmd); history.current.redo = []; bump((n) => n + 1); };
  const run = async (from, to) => {
    const cmd = history.current[from].pop();
    if (!cmd) return;
    bump((n) => n + 1);
    try { await cmd[from === 'undo' ? 'undo' : 'redo'](); history.current[to].push(cmd); }
    catch (e) { toast(`Can't ${from === 'undo' ? 'undo' : 'redo'}: ${e.response?.data?.error ?? 'the task changed meanwhile'}`, 'warn'); load(); }
    bump((n) => n + 1);
  };
  const undo = () => run('undo', 'redo');
  const redo = () => run('redo', 'undo');

  // ---------- mutations ----------
  const findIdx = (id, colId) => (byColumn[colId] || []).findIndex((t) => t.id === id);

  const doMove = async (taskId, toColumnId, index) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task) throw Object.assign(new Error('gone'), { response: { data: { code: 'DELETED' } } });
    const siblings = tasksRef.current.filter((t) => t.columnId === toColumnId && t.id !== taskId).sort((a, b) => a.position - b.position);
    const at = Math.min(index, siblings.length);
    const position = computePosition(siblings.map((s) => s.position), at);
    setTasks((p) => p.map((t) => (t.id === taskId ? { ...t, columnId: toColumnId, position } : t))); // optimistic
    const { data } = await api.patch(`/tasks/${taskId}/move`, { columnId: toColumnId, index: at, expectedVersion: task.version, clientOpId: uid() });
    upsert(data.task);
  };

  const moveTask = async (taskId, toColumnId, index) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task) return;
    const fromColumnId = task.columnId;
    const fromIndex = findIdx(taskId, fromColumnId);
    try {
      await doMove(taskId, toColumnId, index);
      record({ undo: () => doMove(taskId, fromColumnId, fromIndex), redo: () => doMove(taskId, toColumnId, index) });
    } catch (e) { fail(e); } // reverts by refetching the authoritative state
  };

  const applyFields = async (taskId, fields) => {
    const cur = tasksRef.current.find((t) => t.id === taskId);
    if (!cur) throw Object.assign(new Error('gone'), { response: { data: { error: 'task no longer exists' } } });
    const { data } = await api.put(`/tasks/${taskId}`, { ...fields, expectedVersion: cur.version, clientOpId: uid() });
    upsert(data.task);
    return data.task;
  };

  /** Throws on failure so the task panel can run its own conflict-resolution UI. */
  const updateTask = async (task, fields, expectedVersion) => {
    const { data } = await api.put(`/tasks/${task.id}`, { ...fields, expectedVersion, clientOpId: uid() });
    upsert(data.task);
    const prev = Object.fromEntries(Object.keys(fields).map((k) => [k, task[k] ?? null]));
    record({ undo: () => applyFields(task.id, prev), redo: () => applyFields(task.id, fields) });
    return data.task;
  };

  const createTask = async (columnId, fields) => {
    const idRef = { id: null };
    const create = async () => {
      const { data } = await api.post('/tasks', { boardId, columnId, ...fields, clientOpId: uid() });
      idRef.id = data.task.id; upsert(data.task); return data.task;
    };
    const remove = async () => {
      const t = tasksRef.current.find((x) => x.id === idRef.id);
      await api.delete(`/tasks/${idRef.id}`, { params: t ? { expectedVersion: t.version } : {} });
      setTasks((p) => p.filter((x) => x.id !== idRef.id));
    };
    try { const t = await create(); record({ undo: remove, redo: create }); return t; } catch (e) { fail(e, false); return null; }
  };

  const deleteTask = async (task) => {
    const idRef = { id: task.id };
    const snapshot = tasksRef.current;
    const remove = async () => {
      setTasks((p) => p.filter((x) => x.id !== idRef.id)); // optimistic
      const t = snapshot.find((x) => x.id === idRef.id) ?? task;
      await api.delete(`/tasks/${idRef.id}`, { params: { expectedVersion: tasksRef.current.find((x) => x.id === idRef.id)?.version ?? t.version } }).catch(() => {});
    };
    setTasks((p) => p.filter((x) => x.id !== task.id));
    try {
      await api.delete(`/tasks/${task.id}`, { params: { expectedVersion: task.version } });
      const { title, description, assignedTo, priority, dueDate, columnId } = task;
      record({
        undo: async () => { const { data } = await api.post('/tasks', { boardId, columnId, title, description, assignedTo, priority, dueDate, clientOpId: uid() }); idRef.id = data.task.id; upsert(data.task); },
        redo: remove,
      });
      return true;
    } catch (e) { fail(e); return false; }
  };

  return {
    board, columns, tasks, byColumn, loading, gone, reload: load,
    moveTask, updateTask, createTask, deleteTask,
    undo, redo, canUndo: history.current.undo.length > 0, canRedo: history.current.redo.length > 0,
  };
}
