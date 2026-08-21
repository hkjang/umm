import '@fontsource-variable/noto-sans-kr';
import '@mantine/core/styles.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth-context';
import App from './App';
import AppNotifications from './components/AppNotifications';

const theme = createTheme({
  fontFamily: '"Noto Sans KR Variable", "Noto Sans KR", sans-serif',
  headings: { fontFamily: '"Noto Sans KR Variable", "Noto Sans KR", sans-serif', fontWeight: '650' },
  primaryColor: 'grape',
  defaultRadius: 'md',
  fontSizes: { xs: '0.82rem', sm: '0.92rem', md: '1rem', lg: '1.12rem', xl: '1.28rem' },
});

createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <AppNotifications />
    <BrowserRouter>
      <AuthProvider><App /></AuthProvider>
    </BrowserRouter>
  </MantineProvider>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/umm-sw.js').catch(() => undefined));
}
