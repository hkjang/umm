import { Center, Loader } from '@mantine/core';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import LoginPage from './pages/LoginPage';
import AppLayout from './components/AppLayout';
import CanvasPage from './pages/CanvasPage';
import PersonalSettingsPage from './pages/PersonalSettingsPage';
import DreamsPage from './pages/DreamsPage';
import ApprovalsPage from './pages/ApprovalsPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Center h="100%" bg="#f5f2ea"><Loader color="grape" /></Center>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<CanvasPage />} />
        <Route path="/space/:spaceId" element={<CanvasPage />} />
        <Route path="/dreams" element={<DreamsPage />} />
        <Route path="/settings" element={<PersonalSettingsPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/admin/*" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
