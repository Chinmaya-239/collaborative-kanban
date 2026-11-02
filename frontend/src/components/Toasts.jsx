import { useApp } from '../context/AppContext.jsx';

export default function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
    </div>
  );
}
