import { Center, Loader } from '@mantine/core';
import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import LoginPage from './pages/LoginPage';
import AppLayout from './components/AppLayout';

const TodayPage = lazy(() => import('./pages/TodayPage'));
const CanvasPage = lazy(() => import('./pages/CanvasPage'));
const PersonalSettingsPage = lazy(() => import('./pages/PersonalSettingsPage'));
const DreamsPage = lazy(() => import('./pages/DreamsPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const DecisionsPage = lazy(() => import('./pages/DecisionsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

export default function App() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <Center h="100%" bg="var(--shell)">
        <Loader color="grape" />
      </Center>
    );
  if (!user) return <LoginPage />;
  /*
   * Suspense lives inside the layout, not around it.
   *
   * Around it, loading a page's chunk unmounted the header and the navigation
   * too: moving between pages blacked the whole application out and put a
   * spinner in the middle of it, then drew everything back. The frame had not
   * changed and did not need to go anywhere. Now only the content area waits,
   * which is the only part that is actually different.
   */
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/canvas" element={<CanvasPage />} />
        <Route path="/space/:spaceId" element={<CanvasPage />} />
        <Route path="/dreams" element={<DreamsPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/settings" element={<PersonalSettingsPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/admin/*" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/today" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}
