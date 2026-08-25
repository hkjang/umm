import '@fontsource-variable/noto-sans-kr';
import '@mantine/core/styles.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { BrowserRouter } from 'react-router-dom';
import { UnsavedWorkProvider } from './unsaved-work';
import { AuthProvider } from './auth-context';
import { TranslationProvider } from './i18n';
import App from './App';
import AppNotifications from './components/AppNotifications';

const theme = createTheme({
  fontFamily: '"Noto Sans KR Variable", "Noto Sans KR", sans-serif',
  headings: { fontFamily: '"Noto Sans KR Variable", "Noto Sans KR", sans-serif', fontWeight: '650' },
  primaryColor: 'grape',
  defaultRadius: 'md',
  fontSizes: { xs: '0.82rem', sm: '0.92rem', md: '1rem', lg: '1.12rem', xl: '1.28rem' },
});

// The server stamps a fresh nonce into the shell document on every response.
// Handing it to Mantine labels the style elements Mantine injects at runtime,
// which keeps the strict Content-Security-Policy satisfied.
const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;

createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto" getStyleNonce={styleNonce ? () => styleNonce : undefined}>
    <TranslationProvider>
      <AppNotifications />
      <BrowserRouter>
        <AuthProvider>
          {/* Above the router's outlet so the shell can ask a page whether it
              has work that navigating away would throw out. */}
          <UnsavedWorkProvider>
            <App />
          </UnsavedWorkProvider>
        </AuthProvider>
      </BrowserRouter>
    </TranslationProvider>
  </MantineProvider>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/umm-sw.js').catch(() => undefined));
}
