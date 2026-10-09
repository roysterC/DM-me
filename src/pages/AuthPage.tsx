import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserDTO } from '../../shared/types';
import { api, ApiError } from '../api';

export function AuthPage({ mode, onAuthed }: { mode: 'login' | 'signup'; onAuthed: (u: UserDTO) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = signup ? await api.signup(username, password) : await api.login(username, password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="phone auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">DM-me</div>
        <p className="auth-lede">Text Nova, an AI that writes back.</p>
        <label className="field">
          <span>Username</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
            minLength={signup ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {signup && <p className="field-hint">Letters, numbers, periods and underscores. Password at least 8 characters.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-btn" disabled={busy}>
          {busy ? 'One moment…' : signup ? 'Sign up' : 'Log in'}
        </button>
      </form>
      <p className="auth-switch">
        {signup ? (
          <>
            Have an account? <Link to="/login">Log in</Link>
          </>
        ) : (
          <>
            Don’t have an account? <Link to="/signup">Sign up</Link>
          </>
        )}
      </p>
    </div>
  );
}
