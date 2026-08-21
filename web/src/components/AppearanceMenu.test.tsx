import { MantineProvider, Menu } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppearanceMenu from './AppearanceMenu';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';

vi.mock('../auth-context', () => ({ useAuth: () => ({ user: undefined }) }));

function renderMenu() {
  return render(
    <MantineProvider>
      <TranslationProvider>
        <Menu opened>
          <Menu.Dropdown>
            <AppearanceMenu />
          </Menu.Dropdown>
        </Menu>
      </TranslationProvider>
    </MantineProvider>,
  );
}

describe('AppearanceMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    // The provider resolves its language on mount, and jsdom reports an English
    // navigator, so the stored choice is what pins the test to Korean.
    localStorage.setItem('umm:locale', 'ko');
    setLocale('ko');
  });

  it('offers every supported language and theme', async () => {
    renderMenu();
    expect(await screen.findByText('한국어')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('밝게')).toBeInTheDocument();
    expect(screen.getByText('어둡게')).toBeInTheDocument();
  });

  // Switching languages has to re-render every consumer, not just store a
  // value: this is the wiring that turns the dictionary into visible UI.
  it('re-renders its own labels in the chosen language', async () => {
    renderMenu();
    await screen.findByText('밝게');
    setLocale('en');
    expect(await screen.findByText('Light')).toBeInTheDocument();
    expect(screen.queryByText('밝게')).not.toBeInTheDocument();
  });
});
