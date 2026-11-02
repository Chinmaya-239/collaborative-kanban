import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { dateInput, describeLog, PRIORITIES, timeAgo } from '../util.js';

const FIELDS = ['title', 'description', 'assignedTo', 'priority', 'dueDate'];
const toDraft = (t) => ({ title: t.title, description: t.description ?? '', assignedTo: t.assignedTo ?? '', priority: t.priority, dueDate: dateInput(t.dueDate) });
const norm = (k, v) => (k === 'dueDate' ? dateInput(v) : v ?? '');
const toPayload = (k, v) => (k === 'dueDate' ? (v ? new Date(v).toISOString() : null) : k === 'assignedTo' ? v || null : k === 'description' ? v || null : v);

/**
 * Editing is done on a local draft against a base version.
 *  - Remote change while you have NO edits  -> silently adopted.
 *  - Remote change while you HAVE edits     -> banner, nothing is overwritten.
 *  - Save => 409: non-overlapping fields are merged automatically; overlapping fields ask the user.
 */
export default function TaskPanel({ task, columns, members, canDelete, isAdmin, onSave, onDelete, onClose }) {
  const { toast, errMsg, user } = useApp();
  const base = useRef(task);
  const [draft, setDraft] = useState(toDraft(task));
  const [conflict, setConflict] = useState(null);
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const colName = (id) => columns.find((c) => c.id === id)?.name ?? 'a column';
  const changed = FIELDS.filter((k) => norm(k, draft[k]) !== norm(k, base.current[k]));
  const dirty = changed.length > 0;

  useEffect(() => {
    if (task.version === base.current.version) return;
    if (!dirty) { base.current = task; setDraft(toDraft(task)); setRemote(false); } else setRemote(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  useEffect(() => {
    api.get('/activity', { params: { entityId: task.id, limit: 15 } }).then((r) => setHistory(r.data.logs)).catch(() => {});
  }, [task.id, task.version]);

  const adoptLatest = (t) => { base.current = t; setDraft(toDraft(t)); setRemote(false); setConflict(null); };
  const payload = (keys, d = draft) => Object.fromEntries(keys.map((k) => [k, toPayload(k, d[k])]));

  async function save(keys = changed, version = base.current.version) {
    setBusy(true);
    try {
      const saved = await onSave(base.current, payload(keys), version);
      base.current = saved; setDraft((d) => (keys.length === changed.length ? toDraft(saved) : d)); setRemote(false); setConflict(null);
      toast('Saved', 'info');
    } catch (e) {
      const res = e.response?.data;
      if (e.response?.status === 409 && res?.current) {
        const theirs = FIELDS.filter((k) => norm(k, res.current[k]) !== norm(k, base.current[k]));
        const overlap = keys.filter((k) => theirs.includes(k));
        if (!overlap.length) {
          // Different fields were edited: safe to merge. Re-apply ONLY our changes on top of the latest version.
          try {
            const saved = await onSave(res.current, payload(keys), res.current.version);
            base.current = saved; setDraft((d) => ({ ...toDraft(saved), ...Object.fromEntries(FIELDS.filter((k) => !keys.includes(k) && norm(k, d[k]) !== norm(k, base.current[k])).map((k) => [k, d[k]])) }));
            setRemote(false); toast('Merged with another person’s changes to this task', 'info');
          } catch (e2) { toast(errMsg(e2), 'error'); }
        } else setConflict({ current: res.current, fields: overlap });
      } else if (res?.code === 'DELETED') { toast('This task was deleted by someone else.', 'warn'); onClose(); }
      else toast(errMsg(e), 'error');
    } finally { setBusy(false); }
  }

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const label = { title: 'Title', description: 'Description', assignedTo: 'Assignee', priority: 'Priority', dueDate: 'Due date' };
  const show = (k, v) => (k === 'assignedTo' ? members[v]?.name ?? 'Unassigned' : norm(k, v) || '—');

  return (
    <aside className="panel" role="dialog" aria-label="Task details">
      <header><h2>Task details</h2><button className="ghost" onClick={onClose} aria-label="Close">Close</button></header>
      {remote && !conflict && (
        <div className="banner warn">Someone else updated this task while you were editing. <button className="link" onClick={() => adoptLatest(task)}>Load latest (discards your edits)</button></div>
      )}
      {conflict && (
        <div className="banner warn">
          <strong>Conflict.</strong> Another person changed {conflict.fields.map((k) => label[k].toLowerCase()).join(', ')} at the same time.
          <ul>{conflict.fields.map((k) => <li key={k}>{label[k]}: yours “{show(k, draft[k])}” vs theirs “{show(k, conflict.current[k])}”</li>)}</ul>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => save(changed, conflict.current.version)}>Keep my changes</button>
            <button className="ghost" onClick={() => adoptLatest(conflict.current)}>Use their version</button>
          </div>
        </div>
      )}
      <label>Title<input value={draft.title} onChange={set('title')} maxLength={200} /></label>
      <label>Description<textarea rows={5} value={draft.description} onChange={set('description')} maxLength={5000} /></label>
      <div className="grid2">
        <label>Status<input value={colName(task.columnId)} disabled /></label>
        <label>Priority<select value={draft.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Assignee
          <select value={draft.assignedTo} onChange={set('assignedTo')} disabled={!isAdmin && !!draft.assignedTo && draft.assignedTo !== user.id}>
            <option value="">Unassigned</option>
            {Object.values(members).filter((m) => isAdmin || m.id === user.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Due date<input type="date" value={draft.dueDate} onChange={set('dueDate')} /></label>
      </div>
      <p className="muted small">Created {new Date(task.createdAt).toLocaleString()} · Updated {new Date(task.updatedAt).toLocaleString()} · v{task.version}</p>
      <div className="row">
        <button className="primary" disabled={!dirty || busy || !draft.title.trim()} onClick={() => save()}>Save changes</button>
        {canDelete && <button className="danger" onClick={() => window.confirm('Delete this task?') && onDelete(task).then((ok) => ok && onClose())}>Delete</button>}
      </div>
      <h3>History</h3>
      <ul className="log">
        {history.map((l) => <li key={l.id}><strong>{l.user?.name ?? 'Someone'}</strong> {describeLog(l, colName)} <span className="muted">{timeAgo(l.createdAt)}</span></li>)}
        {!history.length && <li className="muted">No history yet.</li>}
      </ul>
    </aside>
  );
}
