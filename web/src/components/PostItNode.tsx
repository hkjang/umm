import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import {
  IconBrain,
  IconDots,
  IconGitBranch,
  IconHelp,
  IconHistory,
  IconMessageCircle,
  IconPalette,
  IconTrash,
} from '@tabler/icons-react';
import { Handle, NodeResizer, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ThoughtNote } from '../api';
import { useTranslation } from '../i18n';

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
  const timer = useRef<number | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => setText(note.content), [note.content]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const schedule = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => data.onPatch(note.id, { content: value }), 450);
  };
  const flush = () => {
    window.clearTimeout(timer.current);
    if (text !== note.content) data.onPatch(note.id, { content: text });
  };
  const colorClass = note.source === 'dream' ? 'lavender' : note.color;

  return (
    <div
      ref={cardRef}
      className={`postit postit-${colorClass} ${note.source === 'dream' ? 'postit-dream' : ''} ${selected ? 'selected' : ''}`}
      style={{ '--note-rotation': `${note.rotation || 0}deg` } as CSSProperties}
      role="group"
      tabIndex={0}
      aria-label={t('생각 메모: {title}', { title: note.title || note.content.slice(0, 80) || t('내용 없음') })}
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
      {data.setAsideLine && (
        <Tooltip label={t('접어 둔 갈래: {line}', { line: data.setAsideLine })} multiline w={220}>
          <span className="postit-set-aside">{t('접어 둠')}</span>
        </Tooltip>
      )}
      {!!data.relatedCount && (
        <button className="related-chip nodrag" type="button" onClick={() => data.onGather(note.id)}>
          {t('관련 {count}', { count: data.relatedCount })}
        </button>
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
