import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ActionIcon, Badge, Button, Group, Loader, Menu, Paper, Text, TextInput, Tooltip } from '@mantine/core';
import { IconArrowRight, IconChevronDown, IconFocusCentered, IconMoonStars, IconPlus, IconSearch, IconSparkles, IconX } from '@tabler/icons-react';
import { ReactFlow, addEdge, Background, BackgroundVariant, Controls, MiniMap, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type OnNodeDrag } from '@xyflow/react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, json, type Space, type ThoughtEdge, type ThoughtNote } from '../api';
import PostItNode, { type PostItData } from '../components/PostItNode';

const nodeTypes = { postit: PostItNode };
const palette: Record<string, string> = { yellow: '#fff0a8', blue: '#dbeeff', purple: '#e9def8', lavender: '#e8e2f1', green: '#d9f0dc', red: '#f8deda', gray: '#e9e7e1' };

interface DreamHistory { dreamId: string; status: string; content: string; spaceId: string; qualityScore: number; }
interface HistoryAction { id: string; before: { x: number; y: number }; after: { x: number; y: number }; }

function CanvasInner() {
  const params = useParams(); const navigate = useNavigate(); const flow = useReactFlow();
  const [spaces, setSpaces] = useState<Space[]>([]); const [activeSpace, setActiveSpace] = useState('');
  const [notes, setNotes] = useState<ThoughtNote[]>([]); const [rawEdges, setRawEdges] = useState<ThoughtEdge[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PostItData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [query, setQuery] = useState(''); const [capture, setCapture] = useState(''); const [loading, setLoading] = useState(true);
  const [morningDream, setMorningDream] = useState<DreamHistory>();
  const notesRef = useRef<Record<string, ThoughtNote>>({}); const queues = useRef<Record<string, Promise<void>>>({});
  const dragStart = useRef<Record<string, {x:number;y:number}>>({}); const undo = useRef<HistoryAction[]>([]); const redo = useRef<HistoryAction[]>([]);

  const syncNotes = (next: ThoughtNote[]) => { setNotes(next); notesRef.current = Object.fromEntries(next.map((n) => [n.id, n])); };
  useEffect(() => { api<{spaces: Space[]}>('/spaces').then(({spaces}) => { setSpaces(spaces); const desired = params.spaceId && spaces.some(s => s.id === params.spaceId) ? params.spaceId : spaces[0]?.id; if (desired) { setActiveSpace(desired); if (!params.spaceId) navigate(`/space/${desired}`, { replace: true }); } }).catch(console.error); }, []);
  useEffect(() => { if (params.spaceId && params.spaceId !== activeSpace) setActiveSpace(params.spaceId); }, [params.spaceId]);
  useEffect(() => { if (!activeSpace) return; setLoading(true); api<{notes: ThoughtNote[]; edges: ThoughtEdge[]}>(`/spaces/${activeSpace}/notes`).then((v) => { syncNotes(v.notes); setRawEdges(v.edges); }).finally(() => setLoading(false)); api<{dreams: DreamHistory[]}>('/dreams').then(({dreams}) => { const fresh = dreams.find(d => d.spaceId === activeSpace && d.status === 'created'); if (fresh && !sessionStorage.getItem(`dream:${fresh.dreamId}`)) setMorningDream(fresh); }).catch(() => undefined); }, [activeSpace]);

  const persist = useCallback((id: string, patch: Partial<ThoughtNote>) => {
    const current = notesRef.current[id]; if (!current) return;
    notesRef.current[id] = { ...current, ...patch }; setNotes((all) => all.map((n) => n.id === id ? { ...n, ...patch } : n));
    const previous = queues.current[id] || Promise.resolve();
    queues.current[id] = previous.catch(() => undefined).then(async () => {
      const base = notesRef.current[id]; if (!base) return;
      const updated = await api<ThoughtNote>(`/notes/${id}`, json('PUT', base));
      notesRef.current[id] = { ...notesRef.current[id], version: updated.version, updatedAt: updated.updatedAt };
      setNotes((all) => all.map((n) => n.id === id ? { ...n, version: updated.version, updatedAt: updated.updatedAt } : n));
    }).catch((error) => console.error('autosave failed', error));
  }, []);

  const remove = useCallback(async (id: string) => { await api(`/notes/${id}`, { method: 'DELETE' }); delete notesRef.current[id]; setNotes((all) => all.filter((n) => n.id !== id)); setRawEdges((all) => all.filter((e) => e.source !== id && e.target !== id)); }, []);

  const gravity = useCallback((selectedID?:string) => { const selected = selectedID ? flow.getNode(selectedID) : flow.getNodes().find(n => n.selected); if (!selected) return; const related = new Set<string>(); rawEdges.forEach(e => { if (e.source === selected.id) related.add(e.target); if (e.target === selected.id) related.add(e.source); }); [...related].forEach((id, index) => { const angle = index / Math.max(1, related.size) * Math.PI * 2; const patch = { x: selected.position.x + Math.cos(angle) * 330, y: selected.position.y + Math.sin(angle) * 230 }; persist(id, patch); }); },[flow,rawEdges,persist]);

  useEffect(() => {
    const q = query.trim().toLocaleLowerCase();
    setNodes(notes.map((note) => ({ id: note.id, type: 'postit', position: { x: note.x, y: note.y }, style: { width: note.width, height: note.height }, data: { note, dimmed: !!q && !`${note.title} ${note.content}`.toLocaleLowerCase().includes(q), relatedCount: rawEdges.filter(e=>e.source===note.id||e.target===note.id).length, onGather: gravity, onPatch: persist, onDelete: remove } })));
  }, [notes, query, rawEdges, persist, remove, gravity]);
  useEffect(() => setEdges(rawEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'smoothstep', animated: e.relation === 'dreamed', label: e.relation === 'related' ? undefined : e.relation }))), [rawEdges]);

  const createAt = useCallback(async (content: string, x: number, y: number) => {
    if (!activeSpace) return; const trimmed = content.trim();
    const created = await api<ThoughtNote>(`/spaces/${activeSpace}/notes`, json('POST', { spaceId: activeSpace, content: trimmed, title: '', color: 'yellow', kind: 'thought', source: 'user', x, y, width: 240, height: 160, rotation: Math.round((Math.random() - .5) * 2), version: 0, authorId: '', id: '', createdAt: '', updatedAt: '' }));
    syncNotes([...Object.values(notesRef.current), created]); setCapture('');
  }, [activeSpace]);

  const onPaneDoubleClick = useCallback((event: React.MouseEvent) => { const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); void createAt('', point.x, point.y); }, [flow, createAt]);
  const connect = useCallback(async (connection: Connection) => { if (!connection.source || !connection.target) return; const created = await api<ThoughtEdge>(`/spaces/${activeSpace}/edges`, json('POST', { id: '', spaceId: activeSpace, source: connection.source, target: connection.target, relation: 'related' })); setRawEdges((all) => [...all, created]); setEdges((all) => addEdge({ ...connection, id: created.id, type: 'smoothstep' }, all)); }, [activeSpace]);
  const onDragStart: OnNodeDrag<Node<PostItData>> = (_, node) => { dragStart.current[node.id] = { ...node.position }; };
  const onDragStop: OnNodeDrag<Node<PostItData>> = (_, node) => { const before = dragStart.current[node.id]; const after = { ...node.position }; if (before && (before.x !== after.x || before.y !== after.y)) { undo.current.push({ id: node.id, before, after }); redo.current = []; } persist(node.id, { x: after.x, y: after.y }); };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement; const editing = ['INPUT','TEXTAREA'].includes(target.tagName) || target.isContentEditable;
      if (!editing && (event.key.toLowerCase() === 'n' || event.key === '/')) { event.preventDefault(); document.getElementById('quick-thought')?.focus(); }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); const action = event.shiftKey ? redo.current.pop() : undo.current.pop(); if (!action) return; const position = event.shiftKey ? action.after : action.before; persist(action.id, position); setNodes((all) => all.map(n => n.id === action.id ? { ...n, position } : n)); (event.shiftKey ? undo.current : redo.current).push(action); }
    }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [persist]);

  const captureKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter' && capture.trim()) { const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }); void createAt(capture, center.x - 120, center.y - 80); } };
  const addSpace=async()=>{const name=window.prompt('새 공간 이름');if(!name?.trim())return;const created=await api<Space>('/spaces',json('POST',{name}));setSpaces(all=>[...all,created]);navigate(`/space/${created.id}`)};
  const dismissDream = async () => { if (!morningDream) return; sessionStorage.setItem(`dream:${morningDream.dreamId}`, 'seen'); await api(`/dreams/${morningDream.dreamId}/feedback`, json('POST', { action: 'exposed' })).catch(() => undefined); setMorningDream(undefined); };
  const activeName = spaces.find(s => s.id === activeSpace)?.name || 'My Space';

  return <div className="canvas-page">
    {loading && <div style={{position:'absolute',inset:0,display:'grid',placeItems:'center',zIndex:10}}><Loader color="grape" /></div>}
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} onNodeDragStart={onDragStart} onNodeDragStop={onDragStop} onPaneClick={(event) => { if (event.detail === 2) onPaneDoubleClick(event); }} fitView fitViewOptions={{ padding: .3 }} minZoom={.15} maxZoom={2.2} deleteKeyCode={null} selectionOnDrag panOnScroll>
      <Background variant={BackgroundVariant.Dots} color="transparent" /><Controls position="bottom-left" showInteractive={false} /><MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => palette[(node.data as PostItData | undefined)?.note?.color || 'yellow'] || '#ddd'} maskColor="rgba(245,242,234,.7)" />
    </ReactFlow>
    <Paper className="canvas-toolbar glass" radius="xl" p={7}><Group gap={6} wrap="nowrap"><Menu shadow="md"><Menu.Target><Button variant="light" color="yellow.8" size="compact-sm" rightSection={<IconChevronDown size={14}/>} style={{textTransform:'none'}}>{activeName}</Button></Menu.Target><Menu.Dropdown><Menu.Label>Spaces</Menu.Label>{spaces.map(space=><Menu.Item key={space.id} onClick={()=>navigate(`/space/${space.id}`)}>{space.name}</Menu.Item>)}<Menu.Divider/><Menu.Item leftSection={<IconPlus size={15}/>} onClick={()=>void addSpace()}>새 공간</Menu.Item></Menu.Dropdown></Menu><TextInput value={query} onChange={(e) => setQuery(e.currentTarget.value)} leftSection={<IconSearch size={17}/>} rightSection={query?<ActionIcon variant="subtle" onClick={() => setQuery('')}><IconX size={15}/></ActionIcon>:null} placeholder="생각 검색" variant="unstyled" style={{flex:1}} /><Tooltip label="선택한 생각과 연결된 메모 모으기"><ActionIcon variant="subtle" color="grape" onClick={()=>gravity()} aria-label="Thought Gravity"><IconFocusCentered size={20}/></ActionIcon></Tooltip></Group></Paper>
    {!loading && notes.length === 0 && <div className="onboarding-hint"><div><IconSparkles size={30} stroke={1.4}/><Text fz="lg" fw={650} mt="sm">여기 아무 곳이나 더블클릭 해보세요.</Text><Text c="dimmed" mt={4}>또는 아래에 생각을 바로 적어보세요.</Text></div></div>}
    <Paper className="quick-capture glass" radius="xl" p={7}><TextInput id="quick-thought" value={capture} onChange={(e) => setCapture(e.currentTarget.value)} onKeyDown={captureKey} placeholder="생각을 입력하세요…" variant="unstyled" px="sm" rightSection={<ActionIcon variant="filled" color="dark" radius="xl" disabled={!capture.trim()} onClick={() => { const center=flow.screenToFlowPosition({x:window.innerWidth/2,y:window.innerHeight/2});void createAt(capture,center.x-120,center.y-80); }} aria-label="생각 붙이기"><IconArrowRight size={18}/></ActionIcon>} /></Paper>
    {morningDream && <div className="morning-overlay"><Paper radius="xl" p={{base:'xl',sm:40}} maw={520} mx="md" className="glass" ta="center"><IconMoonStars size={34} color="#76628f"/><Text size="sm" fw={700} c="grape.7" tt="uppercase" mt="sm">Dream</Text><Text fz={24} fw={660} mt="md">어젯밤, 당신의 생각이 꿈을 꾸었습니다.</Text><Text fz="lg" lh={1.65} mt="lg">{morningDream.content}</Text><Group justify="center" mt="xl"><Button variant="light" color="grape" onClick={dismissDream}>생각 곁에서 보기</Button></Group></Paper></div>}
  </div>;
}

export default function CanvasPage(){return <ReactFlowProvider><CanvasInner/></ReactFlowProvider>;}
