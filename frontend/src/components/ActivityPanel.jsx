import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import { describeLog, timeAgo } from '../util.js';

export default function ActivityPanel({ resyncKey, columns, onClose }) {
  const [logs, setLogs] = useState([]);
  const colName = (id) => columns.find((c) => c.id === id)?.name ?? 'a column';

  useEffect(() => { api.get('/activity', { params: { limit: 50 } }).then((r) => setLogs(r.data.logs)).catch(() => {}); }, [resyncKey]);
  useEffect(() => {
    const s = getSocket();
    const add = ({ log }) => setLogs((p) => (p.some((l) => l.id === log.id) ? p : [log, ...p].slice(0, 100)));
    s?.on('activity:created', add);
    return () => s?.off('activity:created', add);
  }, []);

  return (
    <aside className="drawer" aria-label="Activity">
      <header><h2>Branch activity</h2><button className="ghost" onClick={onClose}>Close</button></header>
      <ul className="log">
        {logs.map((l) => <li key={l.id}><strong>{l.user?.name ?? 'Someone'}</strong> {describeLog(l, colName)}<div className="muted small">{timeAgo(l.createdAt)}</div></li>)}
        {!logs.length && <li className="muted">Nothing has happened in this branch yet.</li>}
      </ul>
    </aside>
  );
}
