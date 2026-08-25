import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import {
  IconBrain,
  IconDots,
  IconExternalLink,
  IconGitBranch,
  IconHeading,
  IconHelp,
  IconHistory,
  IconLink,
  IconMessageCircle,
  IconPalette,
  IconTrash,
} from '@tabler/icons-react';
import { Handle, NodeResizer, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ThoughtNote } from '../api';
import { useTranslation } from '../i18n';
import { noteLinks } from '../note-links';

export type PostItData = {
  note: ThoughtNote;
  // The line this thought belongs to, when it belongs to one that was set
  // aside. v0.24.0 taught the assistant to say so and left the canvas saying
  // nothing — which is where a person actually reads their own thoughts.
  setAsideLine?: string;
  relatedCount?: number;
  onGather: (id: string) => void;
  // Opens the panel where a thought's connections and its line of thinking live,
  // without moving anything. onGather does the same and rearranges the canvas,
  // which is not something a person should have to accept to file a thought.
  onPanel: (id: string) => void;
  onPatch: (id: string, patch: Partial<ThoughtNote>) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onComments: (note: ThoughtNote) => void;
};
export type PostItNodeType = Node<PostItData, 'postit'>;

const colors = ['yellow', 'blue', 'purple', 'green', 'red', 'gray'];

function PostItNode({ data, selected }: NodeProps<PostItNodeType>) {
  const { note } = data;
  const { t } = useTranslation();
  const [text, setText] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  /*
   * A note has a title only if its author gave it one.
   *
   * Importing a document already creates them — a markdown heading becomes the
   * note's title — and the canvas showed none of it. The heading was in the
   * database, in search, on the presentation slide and in what a screen reader
   * read out, and invisible in the one place the person actually looks.
   *
   * It is not inferred from the first line. A thought's opening sentence is
   * usually the thought, not a name for it, and promoting it would put a title
   * on every note whether or not anyone meant one.
   */
  const [namingTitle, setNamingTitle] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => setText(note.content), [note.content]);
  useEffect(() => setTitle(note.title), [note.title]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  /*
   * How much of this thought the card is not showing.
   *
   * The textarea scrolls, so a long note has always been readable — but nothing
   * on the card admitted there was more. Measured on a default note: 179
   * characters, a 168px card, and 169px of text below the fold. More of the
   * thought was hidden than shown, and it ended mid-syllable with no ellipsis.
   * On a canvas whose whole purpose is remembering what you wrote, a card that
   * quietly misreports its own contents is the worst thing it can do.
   */
  const [hiddenLines, setHiddenLines] = useState(0);
  const measure = useCallback(() => {
    const ta = editorRef.current;
    if (!ta) return;
    const hidden = ta.scrollHeight - ta.clientHeight;
    if (hidden <= 2) {
      setHiddenLines(0);
      return;
    }
    const line = Number.parseFloat(getComputedStyle(ta).lineHeight) || 24;
    setHiddenLines(Math.max(1, Math.round(hidden / line)));
  }, []);

  // Re-measured on the text and on the card's size, because either can put a
  // line out of view: typing more, or dragging the note smaller.
  useEffect(measure, [measure, text]);
  useEffect(() => {
    const ta = editorRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(ta);
    return () => observer.disconnect();
  }, [measure]);

  /*
   * Grow the card until the whole thought fits.
   *
   * Only ever on a click. A note's size is something the person set, and this
   * canvas treats what someone arranged as theirs — so the card says there is
   * more and waits, rather than resizing itself the moment text overflows.
   */
  const fitToContent = () => {
    const ta = editorRef.current;
    const card = cardRef.current;
    if (!ta || !card) return;
    // The gap between what the textarea can show and what the card measures,
    // taken from the elements rather than restated from the stylesheet, so
    // padding can change in one place.
    const chrome = card.getBoundingClientRect().height - ta.clientHeight;
    data.onPatch(note.id, { height: Math.ceil(ta.scrollHeight + chrome) });
  };

  const schedule = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => data.onPatch(note.id, { content: value }), 450);
  };
  const flush = () => {
    window.clearTimeout(timer.current);
    if (text !== note.content) data.onPatch(note.id, { content: text });
  };

  const flushTitle = () => {
    const next = title.trim();
    if (next !== note.title) data.onPatch(note.id, { title: next });
    // A name nobody typed is not a name: leaving the field empty puts the card
    // back the way it was rather than leaving a blank line above the thought.
    if (next === '') setNamingTitle(false);
  };
  const colorClass = note.source === 'dream' ? 'lavender' : note.color;
  /*
   * The addresses this thought refers to.
   *
   * Offered from the menu rather than drawn on the card: the body is a textarea
   * so it can be edited, and text in a textarea cannot be a link. Printing them
   * again underneath would put the same address on the card twice, on a card
   * that is already short of room.
   */
  const links = useMemo(() => noteLinks(note.content), [note.content]);

  return (
    <div
      ref={cardRef}
      className={`postit postit-${colorClass} ${note.source === 'dream' ? 'postit-dream' : ''} ${selected ? 'selected' : ''} ${hiddenLines ? 'postit-clipped' : ''} ${hiddenLines > 0 || data.relatedCount ? 'postit-chipped' : ''}`}
      style={{ '--note-rotation': `${note.rotation || 0}deg` } as CSSProperties}
      role="group"
      tabIndex={0}
      // The set-aside line belongs in the name, not only in the badge. A badge is
      // a <span> and its tooltip needs a hover; someone reading this card with a
      // screen reader would otherwise hear a thought that sounds current, which
      // is the exact thing lines of thinking exist to prevent.
      aria-label={
        data.setAsideLine
          ? t('생각 메모: {title} · 접어 둔 갈래: {line}', {
              title: note.title || note.content.slice(0, 80) || t('내용 없음'),
              line: data.setAsideLine,
            })
          : t('생각 메모: {title}', { title: note.title || note.content.slice(0, 80) || t('내용 없음') })
      }
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // Enter is the way into a note without a mouse: arrow keys move the
        // card, Enter starts editing it, and Escape in the textarea comes back
        // out to the card.
        if (event.key === 'Enter') {
          event.preventDefault();
          editorRef.current?.focus();
          editorRef.current?.select();
          return;
        }
        const step = event.shiftKey ? 20 : 5;
        const movement: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = movement[event.key];
        if (delta) {
          event.preventDefault();
          data.onPatch(note.id, { x: note.x + delta[0], y: note.y + delta[1] });
        }
      }}
    >
      <NodeResizer
        minWidth={190}
        minHeight={120}
        isVisible={selected}
        lineStyle={{ borderColor: '#8c7a9f' }}
        handleStyle={{ width: 9, height: 9, borderRadius: 9, background: '#8c7a9f' }}
        onResizeEnd={(_, size) => data.onPatch(note.id, { width: size.width, height: size.height })}
      />
      <Handle className="note-handle" type="target" position={Position.Left} />
      <Handle className="note-handle" type="source" position={Position.Right} />
      {note.source === 'dream' && <div className="dream-label">Dream</div>}
      {/*
       * One row rather than three badges each pinned to the same corner. A note
       * can be set aside AND a question AND held back from Dream at once, and
       * absolutely positioning each one put them on top of each other.
       *
       * It sits above the text rather than over it: once the card became a
       * column so the marks could wrap, DOM order started deciding layout, and
       * this block had been sitting after the textarea — which put the badges
       * underneath the thought instead of above it.
       */}
      <div className="note-badges">
        {data.setAsideLine && (
          <Tooltip label={t('접어 둔 갈래: {line}', { line: data.setAsideLine })} multiline w={220}>
            <span className="note-badge note-badge-set-aside">{t('접어 둠')}</span>
          </Tooltip>
        )}
        {/* Marked by the person, never inferred — so the mark has to be visible.
            It was settable from the menu and left no trace on the card, which
            made it a mark only its author could remember making. */}
        {note.kind === 'question' && (
          <Tooltip label={t('질문으로 표시한 생각')}>
            <span className="note-badge note-badge-question">{t('질문')}</span>
          </Tooltip>
        )}
        {note.aiExcluded && (
          <Tooltip label={t('Dream 분석이 이 생각을 읽지 않습니다')}>
            <span className="note-badge note-badge-excluded">{t('분석 제외')}</span>
          </Tooltip>
        )}
      </div>
      {(note.title !== '' || namingTitle) && (
        <input
          ref={titleRef}
          className="note-title nodrag"
          aria-label={t('생각 제목')}
          value={title}
          placeholder={t('이 생각의 이름')}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onBlur={flushTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              flushTitle();
              // Enter moves on to the thought itself, which is where someone
              // naming a note was heading anyway.
              editorRef.current?.focus();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setTitle(note.title);
              setNamingTitle(note.title !== '');
              cardRef.current?.focus();
            }
          }}
        />
      )}
      <textarea
        ref={editorRef}
        className="nodrag"
        aria-label={t('생각 내용')}
        value={text}
        onChange={(e) => schedule(e.currentTarget.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            flush();
            cardRef.current?.focus();
          }
        }}
        placeholder={t('지금 떠오르는 생각을 적어보세요')}
        autoFocus={note.content === ''}
      />
      {!!data.relatedCount && (
        <button className="related-chip nodrag" type="button" onClick={() => data.onGather(note.id)}>
          {t('관련 {count}', { count: data.relatedCount })}
        </button>
      )}
      {hiddenLines > 0 && (
        <Tooltip label={t('눌러서 생각 전체가 보이게 넓히기')}>
          <button className="more-chip nodrag" type="button" onClick={fitToContent}>
            {t('+{count}줄', { count: hiddenLines })}
          </button>
        </Tooltip>
      )}
      <div className="note-actions nodrag">
        <Menu shadow="sm" width={170} position="bottom-end">
          <Menu.Target>
            <Tooltip label={t('메모 메뉴')}>
              <ActionIcon variant="subtle" color="dark" size="sm" aria-label={t('메모 메뉴')}>
                <IconDots size={17} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            {note.source !== 'dream' && (
              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item leftSection={<IconPalette size={15} />}>{t('색상')}</Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  {colors.map((color) => (
                    <Menu.Item
                      key={color}
                      leftSection={
                        <span
                          style={{ width: 13, height: 13, borderRadius: 99, background: `var(--note-${color}, #ddd)` }}
                        />
                      }
                      onClick={() => data.onPatch(note.id, { color })}
                    >
                      {color}
                    </Menu.Item>
                  ))}
                </Menu.Sub.Dropdown>
              </Menu.Sub>
            )}
            {links.length > 0 && (
              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item leftSection={<IconLink size={15} />}>{t('링크 열기')}</Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  {links.map((link) => (
                    <Menu.Item
                      key={link.href}
                      component="a"
                      href={link.href}
                      target="_blank"
                      // noreferrer as well as noopener: the page being opened
                      // has no business knowing which thought it was opened from.
                      rel="noreferrer"
                      leftSection={<IconExternalLink size={15} />}
                    >
                      {link.label}
                    </Menu.Item>
                  ))}
                </Menu.Sub.Dropdown>
              </Menu.Sub>
            )}
            <Menu.Item
              leftSection={<IconHeading size={15} />}
              onClick={() => {
                if (note.title !== '') {
                  data.onPatch(note.id, { title: '' });
                  setNamingTitle(false);
                  return;
                }
                setNamingTitle(true);
                // Focused after the field exists, so naming a note is one action
                // rather than a menu click and then a hunt for where to type.
                window.setTimeout(() => titleRef.current?.focus(), 0);
              }}
            >
              {t(note.title !== '' ? '제목 지우기' : '제목 붙이기')}
            </Menu.Item>
            {/* Marking, not inferring. umm never decides a note is a question —
                a sentence ending in a question mark often is not one, and a real
                question is often written without one. */}
            <Menu.Item
              color={note.kind === 'question' ? 'blue' : undefined}
              leftSection={<IconHelp size={15} />}
              onClick={() => data.onPatch(note.id, { kind: note.kind === 'question' ? 'thought' : 'question' })}
            >
              {t(note.kind === 'question' ? '질문 표시 해제' : '질문으로 표시')}
            </Menu.Item>
            {note.source !== 'dream' && (
              <Menu.Item
                color={note.aiExcluded ? 'grape' : undefined}
                leftSection={<IconBrain size={15} />}
                onClick={() => data.onPatch(note.id, { aiExcluded: !note.aiExcluded })}
              >
                {t(note.aiExcluded ? 'Dream 분석에 포함' : 'Dream 분석에서 제외')}
              </Menu.Item>
            )}
            <Menu.Item leftSection={<IconGitBranch size={15} />} onClick={() => data.onPanel(note.id)}>
              {t('연결과 갈래')}
            </Menu.Item>
            <Menu.Item leftSection={<IconMessageCircle size={15} />} onClick={() => data.onComments(note)}>
              {t('댓글과 멘션')}
            </Menu.Item>
            <Menu.Item leftSection={<IconHistory size={15} />} onClick={() => data.onRestore(note.id)}>
              {t('이전 버전 복원')}
            </Menu.Item>
            <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => data.onDelete(note.id)}>
              {t('지우기')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}

export default memo(PostItNode);
