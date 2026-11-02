import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useRealtime } from '../hooks/useRealtime.js';
import { useBoard } from '../hooks/useBoard.js';
import { getSocket } from '../socket.js';
import Navbar from '../components/Navbar.jsx';
import Board from '../components/Board.jsx';
import TaskPanel from '../components/TaskPanel.jsx';
import ActivityPanel from '../components/ActivityPanel.jsx';
import MembersPanel from '../components/MembersPanel.jsx';

function Onboarding() {
  const { reload, toast, errMsg } = useApp();
  const [name, setName] = useState('');
  async function create(e) {
    e.preventDefault();
    try { await api.post('/organizations', { name }, { skipTenant: true }); await reload(); } catch (err) { toast(errMsg(err), 'error'); }
  }
  return (
    <div className="center">
      <div className="card-lg">
        <h2>You’re not in any branch yet</h2>
        <p className="muted">Ask a tenant admin to add your email, or start your own organization — you’ll be its admin and can add branches.</p>
        <form className="row" onSubmit={create}>
          <input required placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary">Create organization</button>
        </form>
      </div>
    </div>
  );
}

export default function Workspace() {
  const { tenant, tenantId, isAdmin, role, user, toast, errMsg } = useApp();
  const { status, presence, resyncKey } = useRealtime(tenantId);
  const [boards, setBoards] = useState([]);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardId, setBoardId] = useState(null);
  const [members, setMembers] = useState({});
  const [openId, setOpenId] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const loadBoards = useCallback(async () => {
    if (!tenantId) return;
    try {
      const { data } = await api.get('/boards');
      setBoards(data.boards);
      setBoardId((cur) => (data.boards.some((b) => b.id === cur) ? cur : data.boards[0]?.id ?? null));
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBoardsLoaded(true); }
  }, [tenantId, toast, errMsg]);

  const loadMembers = useCallback(() => {
    if (!tenantId) return;
    api.get(`/tenants/${tenantId}/members`).then((r) => setMembers(Object.fromEntries(r.data.members.map((m) => [m.id, m])))).catch(() => {});
  }, [tenantId]);

  useEffect(() => { loadBoards(); loadMembers(); }, [loadBoards, loadMembers, resyncKey]);
  useEffect(() => {
    const s = getSocket();
    s?.on('members:updated', loadMembers);
    s?.on('board:updated', loadBoards);
    s?.on('board:deleted', loadBoards);
    return () => { s?.off('members:updated', loadMembers); s?.off('board:updated', loadBoards); s?.off('board:deleted', loadBoards); };
  }, [loadMembers, loadBoards]);

  const b = useBoard(boardId, tenantId, resyncKey);
  const open = b.tasks.find((t) => t.id === openId);
  useEffect(() => {
    const onKey = (e) => {
      if (/input|textarea|select/i.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? b.redo() : b.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); b.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const colName = useMemo(() => Object.fromEntries(b.columns.map((c) => [c.id, c.name])), [b.columns]);

  async function addBoard() {
    const name = window.prompt('Board name:');
    if (!name?.trim()) return;
    try { const { data } = await api.post('/boards', { name: name.trim() }); await loadBoards(); setBoardId(data.board.id); } catch (e) { toast(errMsg(e), 'error'); }
  }
  async function removeBoard() {
    if (!window.confirm(`Delete board “${b.board?.name}” and all its tasks?`)) return;
    try { await api.delete(`/boards/${boardId}`); await loadBoards(); } catch (e) { toast(errMsg(e), 'error'); }
  }
  async function addTask(columnId) {
    const title = window.prompt(`New task in “${colName[columnId]}”:`);
    if (!title?.trim()) return;
    await b.createTask(columnId, { title: title.trim(), ...(role === 'MEMBER' ? { assignedTo: user.id } : {}) });
  }

  if (!tenant) return <><Navbar status="denied" presence={[]} /><Onboarding /></>;

  return (
    <div className="app">
      <Navbar status={status} presence={presence} onToggleActivity={() => setShowActivity((v) => !v)} onMembers={() => setShowMembers(true)} />
      <div className="body">
        <nav className="boards" aria-label="Boards">
          <h3>Boards</h3>
          {boards.map((x) => <button key={x.id} className={x.id === boardId ? 'active' : ''} onClick={() => { setBoardId(x.id); setOpenId(null); }}>{x.name}<span className="count">{x._count?.tasks ?? ''}</span></button>)}
          {boardsLoaded && !boards.length && <p className="muted small">No boards in {tenant.name} yet.</p>}
          {isAdmin && <button className="ghost add-board" onClick={addBoard}>+ New board</button>}
        </nav>
        <main className="main">
          {b.board && (
            <div className="toolbar">
              <div><h1>{b.board.name}</h1>{b.board.description && <p className="muted small">{b.board.description}</p>}</div>
              <div className="row">
                <button className="ghost" onClick={b.undo} disabled={!b.canUndo} title="Undo (Ctrl/⌘+Z)">Undo</button>
                <button className="ghost" onClick={b.redo} disabled={!b.canRedo} title="Redo (Ctrl/⌘+Shift+Z)">Redo</button>
                {isAdmin && <button className="ghost" onClick={removeBoard}>Delete board</button>}
              </div>
            </div>
          )}
          {status === 'reconnecting' && <div className="banner warn">Connection lost — reconnecting. The board will resync automatically.</div>}
          {b.gone && <div className="center muted">This board no longer exists.</div>}
          {b.loading && <div className="center muted">Loading board…</div>}
          {b.board && !b.gone && (
            <Board columns={b.columns} byColumn={b.byColumn} tasks={b.tasks} members={members} onMove={b.moveTask} onOpen={setOpenId} onAdd={addTask} />
          )}
          {boardsLoaded && !boardId && <div className="center muted">{isAdmin ? 'Create the first board for this branch.' : 'An admin has not created a board here yet.'}</div>}
        </main>
        {open && (
          <TaskPanel key={open.id} task={open} columns={b.columns} members={members} isAdmin={isAdmin}
            canDelete={isAdmin || open.createdBy === user.id} onSave={b.updateTask} onDelete={b.deleteTask} onClose={() => setOpenId(null)} />
        )}
        {showActivity && !open && <ActivityPanel resyncKey={resyncKey} columns={b.columns} onClose={() => setShowActivity(false)} />}
      </div>
      {showMembers && <MembersPanel tenantId={tenantId} isAdmin={isAdmin} onChanged={loadMembers} onClose={() => setShowMembers(false)} />}
    </div>
  );
}
