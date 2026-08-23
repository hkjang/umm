import { Center, Loader } from '@mantine/core';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth-context';
import { useTranslation } from './i18n';
import LoginPage from './pages/LoginPage';
import AppLayout from './components/AppLayout';

const TodayPage = lazy(() => import('./pages/TodayPage'));
const CanvasPage = lazy(() => import('./pages/CanvasPage'));
const PersonalSettingsPage = lazy(() => import('./pages/PersonalSettingsPage'));
const DreamsPage = lazy(() => import('./pages/DreamsPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const DecisionsPage = lazy(() => import('./pages/DecisionsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

const PageLoader = () => {
  const { t } = useTranslation();
  return (
    <Center h="100%" bg="var(--shell)" role="status" aria-label={t('화면 불러오는 중')}>
      <Loader color="grape" />
    </Center>
  );
};

export default function App() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <Center h="100%" bg="var(--shell)">
        <Loader color="grape" />
      </Center>
    );
  if (!user) return <LoginPage />;
  return (
    <Suspense fallback={<PageLoader />}>
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
    </Suspense>
  );
}
