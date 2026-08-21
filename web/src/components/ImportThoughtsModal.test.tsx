import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import { maxImportedThoughts, type ImportedThought } from '../lib/markdown-import';
import ImportThoughtsModal from './ImportThoughtsModal';

describe('ImportThoughtsModal', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('umm:locale', 'ko');
    setLocale('ko');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
  });

  it('keeps only failed thoughts in the draft after a partial import', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn(async (thoughts: ImportedThought[]) => ({ created: 1, failed: [thoughts[1]] }));
    render(
      <MantineProvider>
        <TranslationProvider>
          <ImportThoughtsModal opened onClose={onClose} onImport={onImport} />
        </TranslationProvider>
      </MantineProvider>,
    );

    const editor = await screen.findByRole('textbox', { name: '가져올 내용' });
    fireEvent.change(editor, { target: { value: '# 저장됨\n\n첫 내용\n\n# 재시도\n\n남길 내용' } });
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
    expect(editor).toHaveValue('# 재시도\n\n남길 내용');
    expect(
      screen.getByText('1개의 생각을 가져오지 못했습니다. 입력란에 남겨 두었으니 다시 시도해 주세요.'),
    ).toBeInTheDocument();
  });

  it('rejects an oversized draft without importing or clearing its tail', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn(async () => ({ created: 0, failed: [] }));
    render(
      <MantineProvider>
        <TranslationProvider>
          <ImportThoughtsModal opened onClose={onClose} onImport={onImport} />
        </TranslationProvider>
      </MantineProvider>,
    );

    const source = Array.from({ length: maxImportedThoughts + 1 }, (_, index) => `# 생각 ${index + 1}\n\n본문`).join(
      '\n\n',
    );
    const editor = await screen.findByRole('textbox', { name: '가져올 내용' });
    fireEvent.change(editor, { target: { value: source } });

    expect(editor).toHaveValue(source);
    expect(screen.getByRole('button', { name: '가져오기' })).toBeDisabled();
    expect(
      screen.getByText(
        `한 번에 최대 ${maxImportedThoughts}개의 생각을 가져올 수 있습니다. 현재 ${maxImportedThoughts + 1}개입니다. 입력을 나누어 다시 시도해 주세요.`,
      ),
    ).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
