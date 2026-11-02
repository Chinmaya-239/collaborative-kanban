import { Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './context/AppContext.jsx';
import Login from './pages/Login.jsx';
import Workspace from './pages/Workspace.jsx';
import Toasts from './components/Toasts.jsx';

export default function App() {
  const { token, ready, tenantId } = useApp();
  return (
    <>
      <Routes>
        <Route path="/login" element={token ? <Navigate to="/" replace /> : <Login />} />
        <Route
          path="/*"
          element={!token ? <Navigate to="/login" replace /> : !ready ? <div className="center muted">Loading…</div> : <Workspace key={tenantId ?? 'none'} />}
        />
      </Routes>
      <Toasts />
    </>
  );
}
