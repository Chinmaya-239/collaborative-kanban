import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { initials } from '../util.js';

const STATUS = { connecting: 'Connecting…', online: 'Live', reconnecting: 'Reconnecting…', denied: 'No access' };

export default function Navbar({ status, presence, onToggleActivity, onMembers }) {
  const { user, orgs, org, tenant, selectOrg, selectTenant, logout, reload, toast, errMsg } = useApp();

  async function addBranch() {
    const name = window.prompt('Name of the new branch (tenant):');
    if (!name?.trim()) return;
    try {
      await api.post('/tenants', { organizationId: org.id, name: name.trim() }, { skipTenant: true });
      await reload();
      toast(`Branch “${name.trim()}” created`, 'info');
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  return (
    <header className="nav">
      <div className="brand">Branchboard</div>
      <label className="sel">
        <span>Organization</span>
        <select value={org?.id ?? ''} onChange={(e) => selectOrg(e.target.value)} disabled={!orgs.length}>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="sel">
        <span>Branch</span>
        <select value={tenant?.id ?? ''} onChange={(e) => selectTenant(e.target.value)} disabled={!org?.tenants.length}>
          {org?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {org?.isOrgAdmin && <button className="ghost" onClick={addBranch}>Add branch</button>}
      <div className="spacer" />
      {tenant && (
        <>
          <span className={`pill ${status}`} title="Real-time connection">{STATUS[status]}</span>
          <div className="presence" aria-label={`${presence.length} online`}>
            <span className="muted">{presence.length} online</span>
            <div className="avatars">
              {presence.slice(0, 6).map((p) => <span key={p.id} className="avatar" title={p.name}>{initials(p.name)}</span>)}
            </div>
          </div>
          <button className="ghost" onClick={onMembers}>People</button>
          <button className="ghost" onClick={onToggleActivity}>Activity</button>
        </>
      )}
      <span className="muted who">{user?.name}{tenant ? ` · ${tenant.role.replace('_', ' ').toLowerCase()}` : ''}</span>
      <button className="ghost" onClick={logout}>Log out</button>
    </header>
  );
}
