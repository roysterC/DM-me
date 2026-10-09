import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { ChatPage } from './pages/ChatPage';

export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
