import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import type { UserDTO } from '../shared/types';
import { api } from './api';
import { AdminPage } from './pages/AdminPage';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';

export function App() {
  const [user, setUser] = useState<UserDTO | null | undefined>(undefined);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="app-shell"><div className="phone center-state" aria-busy="true" /></div>;

  const authed = (u: UserDTO) => {
    setUser(u);
    navigate('/', { replace: true });
  };

  return (
    <div className="app-shell">
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage mode="login" onAuthed={authed} />} />
        <Route path="/signup" element={user ? <Navigate to="/" replace /> : <AuthPage mode="signup" onAuthed={authed} />} />
        <Route
          path="/admin"
          element={!user ? <Navigate to="/login" replace /> : user.isAdmin ? <AdminPage /> : <Navigate to="/" replace />}
        />
        <Route
          path="/"
          element={user ? <ChatPage user={user} onLogout={() => setUser(null)} /> : <Navigate to="/login" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
