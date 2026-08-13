import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconDots, IconHistory, IconPalette, IconTrash } from '@tabler/icons-react';
import { Handle, NodeResizer, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ThoughtNote } from '../api';

export type PostItData = {
  note: ThoughtNote;
  dimmed?: boolean;
  relatedCount?: number;
  onGather: (id: string) => void;
  onPatch: (id: string, patch: Partial<ThoughtNote>) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
};
export type PostItNodeType = Node<PostItData, 'postit'>;

const colors = ['yellow', 'blue', 'purple', 'green', 'red', 'gray'];

function PostItNode({ data, selected }: NodeProps<PostItNodeType>) {
  const { note } = data;
  const [text, setText] = useState(note.content);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setText(note.content), [note.content]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const schedule = (value: string) => {
    setText(value); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => data.onPatch(note.id, { content: value }), 450);
  };
  const flush = () => { window.clearTimeout(timer.current); if (text !== note.content) data.onPatch(note.id, { content: text }); };
  const colorClass = note.source === 'dream' ? 'lavender' : note.color;

  return <div
    className={`postit postit-${colorClass} ${note.source === 'dream' ? 'postit-dream' : ''} ${selected ? 'selected' : ''}`}
    style={{ '--note-rotation': `${note.rotation || 0}deg`, opacity: data.dimmed ? .22 : 1 } as CSSProperties}
  >
    <NodeResizer minWidth={190} minHeight={120} isVisible={selected} lineStyle={{ borderColor: '#8c7a9f' }} handleStyle={{ width: 9, height: 9, borderRadius: 9, background: '#8c7a9f' }} onResizeEnd={(_, size) => data.onPatch(note.id, { width: size.width, height: size.height })} />
    <Handle className="note-handle" type="target" position={Position.Left} />
    <Handle className="note-handle" type="source" position={Position.Right} />
    {note.source === 'dream' && <div className="dream-label">Dream</div>}
    <textarea
      className="nodrag"
      aria-label="생각 내용"
      value={text}
      onChange={(e) => schedule(e.currentTarget.value)}
      onBlur={flush}
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder="지금 떠오르는 생각을 적어보세요"
      autoFocus={note.content === ''}
    />
    {!!data.relatedCount && <button className="related-chip nodrag" type="button" onClick={() => data.onGather(note.id)}>Related {data.relatedCount}</button>}
    <div className="note-actions nodrag">
      <Menu shadow="sm" width={170} position="bottom-end"><Menu.Target><Tooltip label="메모 메뉴"><ActionIcon variant="subtle" color="dark" size="sm" aria-label="메모 메뉴"><IconDots size={17} /></ActionIcon></Tooltip></Menu.Target><Menu.Dropdown>
        {note.source !== 'dream' && <Menu.Sub><Menu.Sub.Target><Menu.Sub.Item leftSection={<IconPalette size={15} />}>색상</Menu.Sub.Item></Menu.Sub.Target><Menu.Sub.Dropdown>{colors.map((color) => <Menu.Item key={color} leftSection={<span style={{ width: 13, height: 13, borderRadius: 99, background: `var(--note-${color}, #ddd)` }} />} onClick={() => data.onPatch(note.id, { color })}>{color}</Menu.Item>)}</Menu.Sub.Dropdown></Menu.Sub>}
        <Menu.Item leftSection={<IconHistory size={15}/>} onClick={()=>data.onRestore(note.id)}>이전 버전 복원</Menu.Item>
        <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => data.onDelete(note.id)}>지우기</Menu.Item>
      </Menu.Dropdown></Menu>
    </div>
  </div>;
}

export default memo(PostItNode);
