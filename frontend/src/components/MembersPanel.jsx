import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';

export default function MembersPanel({ tenantId, isAdmin, onChanged, onClose }) {
  const { toast, errMsg, user } = useApp();
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('MEMBER');

  const load = () => api.get(`/tenants/${tenantId}/members`).then((r) => setMembers(r.data.members)).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e) {
    e.preventDefault();
    try { await api.post(`/tenants/${tenantId}/members`, { email, role }); setEmail(''); await load(); onChanged(); toast('Member saved', 'info'); }
    catch (err) { toast(errMsg(err), 'error'); }
  }
  async function remove(id) {
    try { await api.delete(`/tenants/${tenantId}/members/${id}`); await load(); onChanged(); } catch (err) { toast(errMsg(err), 'error'); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="People">
        <header><h2>People in this branch</h2><button className="ghost" onClick={onClose}>Close</button></header>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <div><strong>{m.name}</strong> <span className="muted small">{m.email}</span></div>
              <span className="chip">{m.role.replace('_', ' ').toLowerCase()}{m.inherited ? ' (organization)' : ''}</span>
              {isAdmin && !m.inherited && m.id !== user.id && <button className="link" onClick={() => remove(m.id)}>Remove</button>}
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <form className="row" onSubmit={add}>
            <input required type="email" placeholder="Registered user’s email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value)}><option value="MEMBER">Member</option><option value="TENANT_ADMIN">Tenant admin</option></select>
            <button className="primary">Add</button>
          </form>
        ) : <p className="muted small">Only tenant admins can add or remove people.</p>}
      </div>
    </div>
  );
}
