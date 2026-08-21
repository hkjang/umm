import { Menu } from '@mantine/core';
import { useMantineColorScheme, type MantineColorScheme } from '@mantine/core';
import { IconDeviceDesktop, IconLanguage, IconMoon, IconSun } from '@tabler/icons-react';
import { api, json } from '../api';
import { useAuth } from '../auth-context';
import { localeLabels, locales, msg, useTranslation, type Locale } from '../i18n';

const schemes: { value: MantineColorScheme; label: string; icon: typeof IconSun }[] = [
  { value: 'light', label: msg('밝게'), icon: IconSun },
  { value: 'dark', label: msg('어둡게'), icon: IconMoon },
  { value: 'auto', label: msg('시스템 설정 따르기'), icon: IconDeviceDesktop },
];

/**
 * Language and theme controls for the profile menu.
 *
 * The choice is applied locally first so it never waits on the network, then
 * mirrored into the stored preferences so it follows the account to another
 * browser. A failed sync is intentionally silent: the local choice already took
 * effect and re-prompting would be noise.
 */
export default function AppearanceMenu() {
  const { t, locale, changeLocale } = useTranslation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { user } = useAuth();

  // The sign-in screen shows this menu too, where there is no account to store
  // the choice against; the local change is all that is needed there.
  const remember = (patch: Record<string, string>) => {
    if (!user) return;
    void api('/preferences', { ...json('PUT', patch), silent: true }).catch(() => undefined);
  };

  const selectLocale = (next: Locale) => {
    changeLocale(next);
    remember({ locale: next });
  };

  const selectScheme = (next: MantineColorScheme) => {
    setColorScheme(next);
    remember({ theme: next === 'auto' ? 'system' : next });
  };

  return (
    <>
      <Menu.Label>{t('언어 선택')}</Menu.Label>
      {locales.map((value) => (
        <Menu.Item
          key={value}
          leftSection={<IconLanguage size={16} />}
          onClick={() => selectLocale(value)}
          bg={locale === value ? 'grape.0' : undefined}
        >
          {localeLabels[value]}
        </Menu.Item>
      ))}
      <Menu.Label>{t('화면 테마')}</Menu.Label>
      {schemes.map(({ value, label, icon: Icon }) => (
        <Menu.Item
          key={value}
          leftSection={<Icon size={16} />}
          onClick={() => selectScheme(value)}
          bg={colorScheme === value ? 'grape.0' : undefined}
        >
          {t(label)}
        </Menu.Item>
      ))}
    </>
  );
}
