import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { setLocale } from '../i18n/translate';
import { maxImportedThoughts, type ImportedDocument } from '../lib/markdown-import';
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
    const onImport = vi.fn(async ({ thoughts }: ImportedDocument) => ({ created: 1, failed: [thoughts[1]] }));
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

  // The cap is for someone else's Markdown. A space of two thousand notes is
  // the size this canvas is built for, and leaving the cap on made its own
  // backup unrestorable — while the advice on screen, to split the input,
  // produced pieces that no longer looked like an export at all.
  it('lets a space larger than the cap come back from its own export', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn(async ({ thoughts }: ImportedDocument) => ({ created: thoughts.length, failed: [] }));
    render(
      <MantineProvider>
        <TranslationProvider>
          <ImportThoughtsModal opened onClose={onClose} onImport={onImport} />
        </TranslationProvider>
      </MantineProvider>,
    );

    const body = Array.from(
      { length: maxImportedThoughts + 50 },
      (_, index) => `## Thought\n\n생각 ${index}\n\n- id: \`n-${index}\`\n- canvas: \`${index}, 0\`\n`,
    ).join('\n');
    const editor = await screen.findByRole('textbox', { name: '가져올 내용' });
    fireEvent.change(editor, {
      target: { value: `# 큰 공간\n\nExported from umm at 2026-08-26T18:00:00+09:00.\n\n${body}` },
    });

    expect(screen.queryByText(new RegExp(`한 번에 최대 ${maxImportedThoughts}개`))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    expect(onImport.mock.calls[0][0].thoughts).toHaveLength(maxImportedThoughts + 50);
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
