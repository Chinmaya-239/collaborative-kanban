import { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';

export default function Login() {
  const { login, register, errMsg } = useApp();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && f.password !== f.confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      if (mode === 'login') await login(f.email, f.password);
      else await register(f.name, f.email, f.password);
    } catch (err) {
      const issues = err.response?.data?.issues;
      setError(issues ? issues.map((i) => `${i.path}: ${i.message}`).join(' · ') : errMsg(err));
    } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <div className="auth-side">
        <h1>Branchboard</h1>
        <p>One task board per branch. Hyderabad sees Hyderabad. Bangalore sees Bangalore. Everyone on the same board sees changes the moment they happen.</p>
        <div className="demo">
          <strong>Demo accounts</strong> (password <code>Password@123</code>)
          <ul>
            <li>rahul@abc.test — org admin</li>
            <li>priya@abc.test — Hyderabad admin</li>
            <li>arjun@abc.test — Hyderabad member</li>
            <li>sneha@abc.test — Bangalore admin</li>
            <li>kiran@xyz.test — XYZ Solutions</li>
          </ul>
        </div>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Log in' : 'Create your account'}</h2>
        {mode === 'register' && <label>Full name<input required value={f.name} onChange={set('name')} autoComplete="name" /></label>}
        <label>Email<input required type="email" value={f.email} onChange={set('email')} autoComplete="email" /></label>
        <label>Password<input required type="password" minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'register' && <label>Confirm password<input required type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
        </button>
      </form>
    </div>
  );
}
