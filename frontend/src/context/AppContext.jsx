import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, errMsg, setActiveTenant, setAuthToken } from '../api.js';
import { connectSocket, disconnectSocket } from '../socket.js';
import { uid } from '../util.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);
const TOKEN_KEY = 'kanban.token'; // sessionStorage: cleared when the tab closes (trade-off documented in README)
const SEL_KEY = 'kanban.selection';

export function AppProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState(null);
  const [tenantId, setTenantId] = useState(null);
  const [ready, setReady] = useState(!token);
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((msg, type = 'info') => {
    const id = uid();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // The stored selection is only a hint: it is re-validated against what the server says we may access.
  const select = useCallback((list, wantOrg, wantTenant) => {
    const org = list.find((o) => o.id === wantOrg) ?? list[0];
    const tenant = org?.tenants.find((t) => t.id === wantTenant) ?? org?.tenants[0];
    setActiveTenant(tenant?.id ?? null); // synchronous, so child effects send the right header
    setOrgId(org?.id ?? null);
    setTenantId(tenant?.id ?? null);
    sessionStorage.setItem(SEL_KEY, JSON.stringify({ orgId: org?.id, tenantId: tenant?.id }));
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SEL_KEY);
    setAuthToken(null); setActiveTenant(null); disconnectSocket();
    setToken(null); setUser(null); setOrgs([]); setOrgId(null); setTenantId(null);
  }, []);

  const loadMe = useCallback(async (keepSelection = true) => {
    const { data } = await api.get('/auth/me', { skipTenant: true });
    setUser(data.user);
    setOrgs(data.organizations);
    const saved = keepSelection ? JSON.parse(sessionStorage.getItem(SEL_KEY) || '{}') : {};
    select(data.organizations, saved.orgId, saved.tenantId);
    return data;
  }, [select]);

  const startSession = useCallback((t) => {
    sessionStorage.setItem(TOKEN_KEY, t);
    setAuthToken(t);
    connectSocket(t); // created before any child effect runs
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    setAuthToken(token);
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    connectSocket(token);
    loadMe().catch(() => logout()).finally(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password }, { skipTenant: true });
    startSession(data.token);
  };
  const register = async (name, email, password) => {
    const { data } = await api.post('/auth/register', { name, email, password }, { skipTenant: true });
    startSession(data.token);
  };

  const value = useMemo(() => {
    const org = orgs.find((o) => o.id === orgId) ?? null;
    const tenant = org?.tenants.find((t) => t.id === tenantId) ?? null;
    return {
      token, user, orgs, org, tenant, tenantId, role: tenant?.role ?? null, ready, toasts,
      isAdmin: tenant?.role === 'TENANT_ADMIN' || tenant?.role === 'ORG_ADMIN',
      login, register, logout, toast, errMsg,
      reload: () => loadMe(true),
      selectOrg: (id) => select(orgs, id, null),
      selectTenant: (id) => select(orgs, orgId, id),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user, orgs, orgId, tenantId, ready, toasts]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
