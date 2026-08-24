import { Alert, Badge, Button, Group, Modal, ScrollArea, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconExternalLink, IconPresentation, IconRefresh } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api, json } from '../api';
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
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ id: string; warnings: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (title.trim()) params.set('title', title.trim());
      if (includeExcluded) params.set('includeExcluded', 'true');
      const query = params.toString();
      setPreview(await api<PresentationPreview>(`/spaces/${spaceID}/presentation/preview${query ? `?${query}` : ''}`));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : t('발표 구성을 만들지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [spaceID, title, includeExcluded, t]);

  useEffect(() => {
    if (!opened) return;
    setMade(null);
    void load();
  }, [opened, load]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { includeExcluded };
      if (title.trim()) body.title = title.trim();
      // Only when the person asked for it: a selection that silently narrowed
      // the deck would drop thoughts they expected to see.
      if (onlySelection && selection.length > 0) body.noteIds = selection;
      const result = await api<{ link: { ptiumId: string }; warnings: string[] }>(
        `/spaces/${spaceID}/presentations`,
        json('POST', body),
      );
      setMade({ id: result.link.ptiumId, warnings: result.warnings ?? [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('발표 자료를 만들지 못했습니다.'));
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

        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={17} />}>
            {error}
          </Alert>
        )}

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
                {!loading && slides.length === 0 && !error && (
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
