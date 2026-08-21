import { translate } from './i18n/translate';

export type NoticeTone = 'success' | 'error' | 'info';

export interface UINotice {
  id: string;
  tone: NoticeTone;
  title: string;
  message: string;
  timeout: number;
}

let noticeSequence = 0;

export function showNotice(input: Omit<UINotice, 'id' | 'timeout'> & { id?: string; timeout?: number }) {
  if (typeof window === 'undefined') return;
  const notice: UINotice = {
    ...input,
    id: input.id || `notice-${Date.now()}-${++noticeSequence}`,
    timeout: input.timeout ?? (input.tone === 'error' ? 8000 : 4500),
  };
  window.dispatchEvent(new CustomEvent<UINotice>('umm:notice', { detail: notice }));
}

export const showError = (message: string, title = translate('요청을 완료하지 못했습니다.'), id?: string) =>
  showNotice({ id, tone: 'error', title, message });

export const showSuccess = (message: string, title = translate('완료되었습니다.')) =>
  showNotice({ tone: 'success', title, message });

export const showInfo = (message: string, title = translate('안내')) => showNotice({ tone: 'info', title, message });
