import { Alert, Badge, Button, Group, Modal, ScrollArea, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconExternalLink, IconPresentation, IconRefresh } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { APIError, api, json } from '../api';
import { useTranslation } from '../i18n';

/**
 * What this space would become as a talk, before anything is made.
 *
 * The reason this screen exists rather than a "make a deck" button: a deck
 * compiled from someone's thinking is only useful if they can see what it is
 * going to say first, and correct it in the space rather than in the deck. So
 * the order, the grouping and the sentences are shown here, and nothing is
 * created until the person asks for it.
 *
 * The sentences on screen are the ones they wrote. Nothing here paraphrases,
 * which is what makes reviewing it worth their time — a summary would have to
 * be re-read against the notes to be trusted.
 */

export interface StorylinePoint {
  Text: string;
  From: string;
  Depth: number;
}

export interface StorylineSlide {
  Role: 'section' | 'content' | 'comparison';
  Title: string;
  Lead: string;
  Points: StorylinePoint[] | null;
  From: string[] | null;
}

export interface Storyline {
  Title: string;
  Slides: StorylineSlide[] | null;
  Excluded: string[] | null;
}

export interface PresentationLink {
  id: string;
  ptiumId: string;
  title: string;
  status: 'pending' | 'generating' | 'ready' | 'failed';
  /** The underlying error. Kept for whoever fixes it, not for the tooltip. */
  error?: string;
  /**
   * What sort of failure it was. This is what decides the sentence a person
   * reads: the stored `error` names internal hosts and Go types, which says
   * what happened and not what to do about it. Empty on decks recorded before
   * v0.60.0.
   */
  failureKind?: string;
  thoughtCount: number;
  excludedCount: number;
  /** Where the deck can be opened. Absent when no Ptium is configured. */
  url?: string;
  /**
   * How many of this deck's slides quote a thought that has since been
   * rewritten or deleted. Moving a thought does not count — the check is on the
   * words, not the note's version, which also changes when a note is dragged.
   */
  staleSlides?: number;
}

export interface PresentationPreview {
  storyline: Storyline;
  source: string;
  slideCount: number;
  warnings: string[] | null;
  checked: boolean;
}

interface Props {
  opened: boolean;
  onClose: () => void;
  spaceID: string;
  spaceName: string;
  /** Restricts the talk to a selection, when one is active on the canvas. */
  selection?: string[];
}

/** How many thoughts reached a slide, counted once. */
const thoughtsUsed = (storyline: Storyline) => {
  const seen = new Set<string>();
  for (const slide of storyline.Slides ?? []) for (const id of slide.From ?? []) seen.add(id);
  return seen.size;
};

export default function PresentationModal({ opened, onClose, spaceID, spaceName, selection = [] }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [onlySelection, setOnlySelection] = useState(false);
  const [preview, setPreview] = useState<PresentationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Not just a sentence: a Ptium failure has a kind, sometimes Ptium's own
  // words, and — for administrators — the underlying error. Keeping them apart
  // is what lets the screen say who fixes this instead of pasting a Go error
  // into the middle of a Korean sentence.
  const [failure, setFailure] = useState<PtiumFailure | null>(null);
  const [made, setMade] = useState<{ id: string; warnings: string[] } | null>(null);
  const [history, setHistory] = useState<PresentationLink[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const body = await api<{ presentations: PresentationLink[] }>(`/spaces/${spaceID}/presentations`);
      setHistory(body.presentations ?? []);
    } catch {
      // A history that cannot be read must not stop someone making a new deck.
      setHistory([]);
    }
  }, [spaceID]);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const params = new URLSearchParams();
      if (title.trim()) params.set('title', title.trim());
      if (includeExcluded) params.set('includeExcluded', 'true');
      const query = params.toString();
      setPreview(await api<PresentationPreview>(`/spaces/${spaceID}/presentation/preview${query ? `?${query}` : ''}`));
    } catch (cause) {
      setPreview(null);
      setFailure(readFailure(cause, t('발표 구성을 만들지 못했습니다.')));
    } finally {
      setLoading(false);
    }
  }, [spaceID, title, includeExcluded, t]);

  useEffect(() => {
    if (!opened) return;
    setMade(null);
    void load();
    void loadHistory();
  }, [opened, load, loadHistory]);

  const create = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const body: Record<string, unknown> = { includeExcluded };
      if (title.trim()) body.title = title.trim();
      // Only when the person asked for it: a selection that silently narrowed
      // the deck would drop thoughts they expected to see.
      if (onlySelection && selection.length > 0) body.noteIds = selection;
      const result = await api<{ link: PresentationLink; warnings: string[] }>(
        `/spaces/${spaceID}/presentations`,
        json('POST', body),
      );
      setMade({ id: result.link.ptiumId, warnings: result.warnings ?? [] });
      void loadHistory();
    } catch (cause) {
      setFailure(readFailure(cause, t('발표 자료를 만들지 못했습니다.')));
    } finally {
      setBusy(false);
    }
  };

  const storyline = preview?.storyline;
  const slides = storyline?.Slides ?? [];
  const excluded = storyline?.Excluded ?? [];

  return (
    <Modal opened={opened} onClose={busy ? () => undefined : onClose} title={t('발표로 만들기')} centered size="lg">
      <Stack gap="sm">
        <TextInput
          label={t('제목')}
          placeholder={spaceName}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onBlur={() => void load()}
        />

        <Group gap="lg">
          {/* A thought held back from Dream analysis is held back from having
              things done to it, and being put on a slide is one of those. */}
          <Switch
            label={t('분석에서 제외한 생각도 넣기')}
            checked={includeExcluded}
            onChange={(event) => setIncludeExcluded(event.currentTarget.checked)}
          />
          {selection.length > 0 && (
            <Switch
              label={t('선택한 생각만 ({count}개)', { count: selection.length })}
              checked={onlySelection}
              onChange={(event) => setOnlySelection(event.currentTarget.checked)}
            />
          )}
        </Group>

        {failure && <PtiumFailureAlert failure={failure} onRetry={failure.retryable ? () => void load() : undefined} />}

        {made ? (
          <Alert color="green" icon={<IconPresentation size={17} />} title={t('발표 자료를 만들었습니다.')}>
            <Stack gap={6}>
              <Text size="sm">{t('Ptium에서 이어서 편집할 수 있습니다.')}</Text>
              {made.warnings.length > 0 && (
                <Stack gap={2}>
                  {/* Ptium adjusts source it cannot honour exactly rather than
                      refusing it. A deck that quietly lost a line is worse than
                      one that says it did. */}
                  <Text size="sm" fw={600}>
                    {t('Ptium이 조정한 부분')}
                  </Text>
                  {made.warnings.map((warning) => (
                    <Text key={warning} size="sm" c="dimmed">
                      · {warning}
                    </Text>
                  ))}
                </Stack>
              )}
            </Stack>
          </Alert>
        ) : (
          <>
            {storyline && slides.length > 0 && (
              <Group gap="xs">
                <Badge variant="light">
                  {t('슬라이드 {count}장', { count: slides.length + (storyline.Title ? 1 : 0) })}
                </Badge>
                <Badge variant="light" color="gray">
                  {t('생각 {count}개', { count: thoughtsUsed(storyline) })}
                </Badge>
                {excluded.length > 0 && (
                  <Tooltip label={t('분석에서 제외한 생각입니다. 위 스위치로 넣을 수 있습니다.')}>
                    <Badge variant="light" color="grape">
                      {t('{count}개 제외', { count: excluded.length })}
                    </Badge>
                  </Tooltip>
                )}
                {/* Never checked must not read as checked and clean: Ptium can
                    only measure source against a deck that already exists. */}
                {!preview?.checked && (
                  <Tooltip label={t('레이아웃은 만든 뒤에 Ptium이 확인합니다.')}>
                    <Badge variant="outline" color="gray">
                      {t('레이아웃 미확인')}
                    </Badge>
                  </Tooltip>
                )}
              </Group>
            )}

            <ScrollArea.Autosize mah={340} type="auto">
              <Stack gap={4} className="storyline-preview">
                {loading && <Text c="dimmed">{t('구성을 만드는 중입니다…')}</Text>}
                {!loading && slides.length === 0 && !failure && (
                  <Text c="dimmed">{t('발표로 만들 생각이 없습니다.')}</Text>
                )}
                {slides.map((slide, index) => (
                  <div key={`${index}-${slide.Title}`} className={`storyline-slide storyline-${slide.Role}`}>
                    <Group gap={7} wrap="nowrap" align="baseline">
                      <Text size="xs" c="dimmed" className="storyline-number">
                        {index + 1 + (storyline?.Title ? 1 : 0)}
                      </Text>
                      <Text fw={620}>{slide.Title}</Text>
                      {slide.Role === 'comparison' && (
                        <Tooltip label={t('서로 어긋난다고 표시해 둔 두 생각입니다.')}>
                          <Badge size="xs" variant="light" color="orange">
                            {t('맞섬')}
                          </Badge>
                        </Tooltip>
                      )}
                      {slide.Role === 'section' && (
                        <Badge size="xs" variant="light" color="blue">
                          {t('질문')}
                        </Badge>
                      )}
                    </Group>
                    {slide.Lead && (
                      <Text size="sm" c="dimmed" className="storyline-lead">
                        {slide.Lead}
                      </Text>
                    )}
                    {(slide.Points ?? []).map((point, pointIndex) => (
                      <Text
                        key={`${pointIndex}-${point.From}`}
                        size="sm"
                        className="storyline-point"
                        style={{ paddingLeft: 14 + point.Depth * 14 }}
                      >
                        · {point.Text}
                      </Text>
                    ))}
                  </div>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </>
        )}

        {history.length > 0 && (
          <Stack gap={4}>
            {/* What this space has already produced. It belongs here rather
                than on a page of its own because this is where a person is
                standing when the question "did I already make one of these"
                occurs to them. */}
            <Text size="sm" fw={620}>
              {t('이 공간으로 만든 발표')}
            </Text>
            {history.map((link) => (
              <Group key={link.id} gap={8} wrap="nowrap" className="presentation-history-row">
                <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                  {link.title || t('제목 없음')}
                </Text>
                {link.status === 'failed' ? (
                  /* The kind, not the stored error: a dial-tcp message naming
                     an internal host, shown under the word 실패, tells a person
                     nothing they can act on. */
                  <Tooltip label={failureSummary(link, t)} multiline w={280}>
                    <Badge size="sm" variant="light" color="red">
                      {t('실패')}
                    </Badge>
                  </Tooltip>
                ) : link.staleSlides ? (
                  /* The deck was true when it was made and the thinking has
                     moved on since. Only umm is in a position to notice, and
                     saying which slides is what makes it actionable rather than
                     just unsettling. */
                  <Tooltip
                    label={t('이 발표가 인용한 생각이 그 뒤에 바뀌었습니다. 다시 만들면 반영됩니다.')}
                    multiline
                    w={260}
                  >
                    <Badge size="sm" variant="light" color="orange">
                      {t('슬라이드 {count}장 바뀜', { count: link.staleSlides })}
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge size="sm" variant="light" color="gray">
                    {t('생각 {count}개', { count: link.thoughtCount })}
                  </Badge>
                )}
                {link.url && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    component="a"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    leftSection={<IconExternalLink size={13} />}
                  >
                    {t('열기')}
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        )}

        <Group justify="space-between">
          <Button
            variant="subtle"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void load()}
            disabled={loading || busy || !!made}
          >
            {t('다시 구성')}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={onClose} disabled={busy}>
              {made ? t('닫기') : t('취소')}
            </Button>
            {!made && (
              <Button
                leftSection={<IconExternalLink size={16} />}
                onClick={() => void create()}
                loading={busy}
                disabled={loading || slides.length === 0}
              >
                {t('Ptium에서 만들기')}
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * A Ptium failure as the screen needs it.
 *
 * `message` is umm's sentence about who fixes this. `ptiumDetail` is Ptium's
 * own words, present only when Ptium said something worth repeating — a proxy's
 * HTML error page is dropped before it gets here. `technical` is the underlying
 * error, which the server sends only to administrators.
 */
interface PtiumFailure {
  kind: string;
  title: string;
  message: string;
  ptiumDetail?: string;
  technical?: string;
  requestId?: string;
  retryable: boolean;
}

// The kinds worth offering a retry for: something was momentarily wrong rather
// than misconfigured. Offering "try again" for a wrong API key would be the
// screen promising something it knows cannot work.
const retryableFailures = new Set(['unreachable', 'timed-out', 'remote-error']);

function readFailure(cause: unknown, fallback: string): PtiumFailure {
  if (cause instanceof APIError) {
    const payload = cause.payload ?? {};
    const kind = typeof payload.failure === 'string' ? payload.failure : '';
    return {
      kind,
      title: typeof payload.title === 'string' ? payload.title : '',
      message: cause.message || fallback,
      ptiumDetail: typeof payload.ptiumDetail === 'string' ? payload.ptiumDetail : undefined,
      technical: typeof payload.technical === 'string' ? payload.technical : undefined,
      requestId: typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : undefined,
      retryable: retryableFailures.has(kind),
    };
  }
  return {
    kind: '',
    title: '',
    message: cause instanceof Error ? cause.message : fallback,
    retryable: false,
  };
}

function PtiumFailureAlert({ failure, onRetry }: { failure: PtiumFailure; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert color="red" icon={<IconAlertTriangle size={17} />} title={failure.title || undefined}>
      <Stack gap={8}>
        <Text size="sm">{failure.message}</Text>
        {/* Ptium's own words, marked as Ptium's. The 422 case is the one that
            actually tells an author what to change, and it names the slide. */}
        {failure.ptiumDetail && (
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('Ptium이 보낸 설명')}
            </Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {failure.ptiumDetail}
            </Text>
          </Stack>
        )}
        {/* Only administrators are sent this, because it names internal hosts,
            Go types and SQL constraints — things the person who wanted slides
            can neither use nor act on. */}
        {failure.technical && (
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('기술 정보 (관리자에게만 보입니다)')}
            </Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {failure.technical}
            </Text>
          </Stack>
        )}
        <Group gap="xs">
          {onRetry && (
            <Button size="xs" variant="light" color="red" onClick={onRetry}>
              {t('다시 시도')}
            </Button>
          )}
          {/* The one thing a person can carry to whoever fixes it. */}
          {failure.requestId && (
            <Text size="xs" c="dimmed">
              {t('요청 번호 {id}', { id: failure.requestId })}
            </Text>
          )}
        </Group>
      </Stack>
    </Alert>
  );
}

/**
 * One sentence for a deck that failed, chosen by what kind of failure it was.
 *
 * Decks recorded before v0.60.0 have no kind, and for those the stored error is
 * still better than nothing — it is at least what happened.
 */
function failureSummary(link: PresentationLink, t: (key: string) => string): string {
  switch (link.failureKind) {
    case 'unreachable':
      return t('Ptium 서버에 연결하지 못했습니다. 잠시 뒤 다시 만들어 보세요.');
    case 'timed-out':
      return t('Ptium이 제때 답하지 않았습니다. 다시 만들어 보세요.');
    case 'unauthorized':
      return t('Ptium이 umm의 API 키를 거부했습니다. 관리자가 키를 다시 설정해야 합니다.');
    case 'no-api':
      return t('설정된 주소에 Ptium API가 없습니다. 관리자가 주소를 확인해야 합니다.');
    case 'rejected':
      return t(
        'Ptium이 이 발표 구성을 슬라이드로 만들 수 없다고 답했습니다. 생각을 줄이거나 나눈 뒤 다시 시도해 보세요.',
      );
    case 'remote-error':
      return t('Ptium 쪽에서 오류가 났습니다. 잠시 뒤 다시 만들어 보세요.');
    case 'unexpected-response':
      return t('Ptium이 예상과 다른 형식으로 답했습니다. 관리자가 Ptium 버전을 확인해야 합니다.');
    case 'not-recorded':
      return t('덱은 Ptium에 만들어졌지만 umm이 기록하지 못했습니다. Ptium에서 먼저 확인해 주세요.');
    default:
      return link.error || t('만들지 못했습니다.');
  }
}
