import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconDownload,
  IconEdit,
  IconFileImport,
  IconFileTypePdf,
  IconFocusCentered,
  IconGitMerge,
  IconLayoutGrid,
  IconList,
  IconMarkdown,
  IconMessageCircle,
  IconMoonStars,
  IconPhoto,
  IconPlus,
  IconFocus2,
  IconSearch,
  IconSettings,
  IconShare,
  IconSparkles,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import {
  ReactFlow,
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnNodeDrag,
} from '@xyflow/react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  APIError,
  api,
  discardOfflineMutation,
  json,
  type EdgeStyle,
  type NoteComment,
  type Preferences,
  type Space,
  type EdgeRelation,
  type Cluster,
  type SpaceSuggestion,
  type SuggestionResult,
  type ThoughtEdge,
  type ThoughtNote,
} from '../api';
import PostItNode, { type PostItData } from '../components/PostItNode';
import { useAuth } from '../auth-context';
import { msg, useTranslation } from '../i18n';
import ImportThoughtsModal from '../components/ImportThoughtsModal';
import BranchPanel from '../components/BranchPanel';
import { neighbourhood } from '../lens';
import type { Branch } from '../components/BranchPanel';
import { readLocalStorage, readSessionStorage, writeLocalStorage, writeSessionStorage } from '../lib/browser-storage';
import { importLayout, type ImportedThought, type ImportThoughtsResult } from '../lib/markdown-import';
import { originLabel, relationLabel, relationOptions } from '../lib/edge-vocabulary';
import { restoreAfterFailedWrite } from '../lib/optimistic-write';
import ClusterNode, { type ClusterNodeData } from '../components/ClusterNode';
import { showError, showInfo, showSuccess } from '../ui-notifications';

const nodeTypes = { postit: PostItNode, cluster: ClusterNode };

type CanvasNode = Node<PostItData> | Node<ClusterNodeData>;

// Below this zoom the text on a post-it is not readable anyway, so the canvas
// stops drawing notes and starts drawing what they add up to. Chosen against the
// existing 0.15 floor and 2.2 ceiling: it is roughly where a note becomes a
// coloured rectangle.
const clusterZoom = 0.45;

// Summarising exists to answer information overload, so it does not apply to a
// canvas that has none. Opening a space with a dozen notes zooms out far enough
// to cross the threshold, and replacing them with two bubbles there is a worse
// view of the same thing — the notes were perfectly legible as they were.
const clusterMinNotes = 25;
const palette: Record<string, string> = {
  yellow: '#fff0a8',
  blue: '#dbeeff',
  purple: '#e9def8',
  lavender: '#e8e2f1',
  green: '#d9f0dc',
  red: '#f8deda',
  gray: '#e9e7e1',
};
const aiTools = [
  ['summarize', msg('요약')],
  ['questions', msg('질문 만들기')],
  ['expand', msg('확장')],
  ['challenge', msg('반대 관점')],
  ['actions', msg('실행 항목')],
];
const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

interface DreamHistory {
  dreamId: string;
  status: string;
  content: string;
  spaceId: string;
  qualityScore: number;
}
interface HistoryAction {
  id: string;
  before: { x: number; y: number };
  after: { x: number; y: number };
}
interface RelatedThought {
  note: ThoughtNote;
  score: number;
  reason: string;
}
interface Backlink {
  edge: ThoughtEdge;
  note: ThoughtNote;
  direction: 'incoming' | 'outgoing';
}
interface SpaceMember {
  id: string;
  username: string;
  displayName: string;
  email: string;
  permission: string;
}
type NoteWritePayload = Pick<
  ThoughtNote,
  'content' | 'title' | 'color' | 'kind' | 'aiExcluded' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'version'
>;

const noteWritePayload = (note: ThoughtNote): NoteWritePayload => ({
  content: note.content,
  title: note.title,
  color: note.color,
  kind: note.kind,
  aiExcluded: note.aiExcluded,
  x: note.x,
  y: note.y,
  width: note.width,
  height: note.height,
  rotation: note.rotation,
  version: note.version,
});

function CanvasInner() {
  const { t, formatDate } = useTranslation();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const flow = useReactFlow();
  const { user } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpace, setActiveSpace] = useState('');
  const [notes, setNotes] = useState<ThoughtNote[]>([]);
  const [rawEdges, setRawEdges] = useState<ThoughtEdge[]>([]);
  // The canvas holds post-its at working zoom and cluster shapes below it, so
  // the node type is the union of the two rather than post-its alone.
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [query, setQuery] = useState('');
  const [capture, setCapture] = useState('');
  const [loading, setLoading] = useState(true);
  // What a line drawn from here on will assert. Kept in the toolbar rather than
  // asked for after each drag: someone marking up contradictions draws several
  // in a row, and a dialog per line would make that unbearable.
  const [drawRelation, setDrawRelation] = useState<EdgeRelation>(() => {
    const stored = readLocalStorage('umm:draw-relation').value;
    return relationOptions.includes(stored as EdgeRelation) ? (stored as EdgeRelation) : 'related';
  });
  const [edgeStyle, setEdgeStyle] = useState<EdgeStyle>(() => {
    const stored = readLocalStorage('umm:edge-style').value;
    return stored === 'smoothstep' || stored === 'straight' ? stored : 'bezier';
  });
  const [exportBusy, setExportBusy] = useState('');
  const [searchIndex, setSearchIndex] = useState(-1);
  const [spaceQuery, setSpaceQuery] = useState('');
  const [spaceManagerOpen, setSpaceManagerOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [spaceDrafts, setSpaceDrafts] = useState<Record<string, string>>({});
  const [spaceBusy, setSpaceBusy] = useState('');
  const [spaceError, setSpaceError] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<Space>();
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [morningDream, setMorningDream] = useState<DreamHistory>();
  const [related, setRelated] = useState<{ source: string; items: RelatedThought[] }>();
  const [aiResult, setAIResult] = useState<{ mode: string; content: string }>();
  const [aiBusy, setAIBusy] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  // Suggestions umm wrote into the graph on this run. They already exist as
  // inferred edges, so this list is only the review queue for them.
  const [suggestions, setSuggestions] = useState<ThoughtEdge[]>([]);
  // Semantic zoom. Only the side of the threshold matters, so this is a boolean
  // rather than the zoom value: storing the number would rerender the canvas on
  // every wheel tick to no purpose.
  const [zoomedOut, setZoomedOut] = useState(false);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  // Where the selected thought could be filed. Loaded with the connection panel,
  // because filing and connecting are the two things you do to a thought you are
  // looking at.
  const [homes, setHomes] = useState<SpaceSuggestion[]>([]);
  const [filing, setFiling] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  // Looking at one line of thinking at a time.
  //
  // The rest is dimmed, never hidden. A thought that disappears reads as a
  // thought that was deleted, and a canvas that quietly drops two thirds of
  // itself is telling the person their workspace is smaller than it is.
  const [lens, setLens] = useState<{ label: string; ids: Set<string> }>();
  // Branches are loaded for the whole space, not just the selected thought: a
  // thought in a line that was set aside has to be marked whether or not anyone
  // has clicked it.
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchAssignments, setBranchAssignments] = useState<Record<string, string>>({});
  const [listView, setListView] = useState(false);
  const [commentNote, setCommentNote] = useState<ThoughtNote>();
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [conflict, setConflict] = useState<{ local: ThoughtNote; latest: ThoughtNote; offlineMutationId?: string }>();
  const [mergeDraft, setMergeDraft] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [shareUser, setShareUser] = useState('');
  const [sharePermission, setSharePermission] = useState('edit');
  const [shareMessage, setShareMessage] = useState('');
  const notesRef = useRef<Record<string, ThoughtNote>>({});
  const durableNotesRef = useRef<Record<string, ThoughtNote>>({});
  const queues = useRef<Record<string, Promise<void>>>({});
  const dragStart = useRef<Record<string, { x: number; y: number }>>({});
  const undo = useRef<HistoryAction[]>([]);
  const redo = useRef<HistoryAction[]>([]);
  const focusedShortcut = useRef('');

  const syncNotes = (next: ThoughtNote[], replaceDurable = false) => {
    setNotes(next);
    notesRef.current = Object.fromEntries(next.map((n) => [n.id, n]));
    if (replaceDurable) durableNotesRef.current = Object.fromEntries(next.map((n) => [n.id, n]));
  };
  useEffect(() => {
    api<{ spaces: Space[] }>('/spaces')
      .then(({ spaces }) => {
        setSpaces(spaces);
        setSpaceDrafts(Object.fromEntries(spaces.map((space) => [space.id, space.name])));
        const desired = params.spaceId && spaces.some((s) => s.id === params.spaceId) ? params.spaceId : spaces[0]?.id;
        if (desired) {
          setActiveSpace(desired);
          if (!params.spaceId) navigate(`/space/${desired}`, { replace: true });
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    api<Preferences>('/preferences', { silent: true })
      .then((value) => {
        const style = value.edge_style || 'bezier';
        setEdgeStyle(style);
        writeLocalStorage('umm:edge-style', style);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (params.spaceId && params.spaceId !== activeSpace) setActiveSpace(params.spaceId);
  }, [params.spaceId]);
  const loadCanvas = useCallback(
    async (silent = false) => {
      if (!activeSpace) return;
      if (!silent) setLoading(true);
      try {
        const v = await api<{ notes: ThoughtNote[]; edges: ThoughtEdge[] }>(`/spaces/${activeSpace}/notes`);
        syncNotes(v.notes, true);
        setRawEdges(v.edges);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activeSpace],
  );
  const loadBranches = useCallback(async () => {
    if (!activeSpace) return;
    try {
      const result = await api<{ branches: Branch[]; assignments: Record<string, string> }>(
        `/spaces/${activeSpace}/branches`,
        { silent: true },
      );
      setBranches(result.branches);
      setBranchAssignments(result.assignments ?? {});
    } catch {
      // A space with no branches is the ordinary case, and a failure here must
      // not take the canvas down with it.
      setBranches([]);
      setBranchAssignments({});
    }
  }, [activeSpace]);
  useEffect(() => {
    if (!activeSpace) return;
    void loadCanvas().catch(() => undefined);
    void loadBranches();
    api<{ dreams: DreamHistory[] }>('/dreams', { silent: true })
      .then(({ dreams }) => {
        const fresh = dreams.find((d) => d.spaceId === activeSpace && d.status === 'created');
        if (fresh && !readSessionStorage(`dream:${fresh.dreamId}`).value) setMorningDream(fresh);
      })
      .catch(() => undefined);
  }, [activeSpace, loadCanvas, loadBranches]);
  useEffect(() => {
    if (!activeSpace) return;
    const stream = new EventSource(`/api/v1/spaces/${activeSpace}/events`);
    stream.addEventListener('space-change', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data.actorId !== user?.id) void loadCanvas(true);
      } catch {
        void loadCanvas(true);
      }
    });
    return () => stream.close();
  }, [activeSpace, user?.id, loadCanvas]);

  const persist = useCallback((id: string, patch: Partial<ThoughtNote>) => {
    const current = notesRef.current[id];
    if (!current) return;
    notesRef.current[id] = { ...current, ...patch };
    setNotes((all) => all.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    const previous = queues.current[id] || Promise.resolve();
    queues.current[id] = previous
      .catch(() => undefined)
      .then(async () => {
        const base = notesRef.current[id];
        if (!base) return;
        try {
          const updated = await api<ThoughtNote>(`/notes/${id}`, {
            ...json('PUT', noteWritePayload(base)),
            queueIfOffline: true,
          });
          const confirmed = { ...base, version: updated.version, updatedAt: updated.updatedAt };
          durableNotesRef.current[id] = confirmed;
          const currentAfterWrite = notesRef.current[id];
          if (!currentAfterWrite) return;
          const visible =
            currentAfterWrite === base
              ? confirmed
              : { ...currentAfterWrite, version: updated.version, updatedAt: updated.updatedAt };
          notesRef.current[id] = visible;
          setNotes((all) => all.map((n) => (n.id === id ? visible : n)));
        } catch (error) {
          if (error instanceof APIError && error.queued) {
            durableNotesRef.current[id] = base;
            return;
          }
          if (error instanceof APIError && error.status === 409 && error.payload.latest) {
            const latest = error.payload.latest as ThoughtNote;
            durableNotesRef.current[id] = latest;
            setConflict({ local: base, latest });
            setMergeDraft(base.content);
            return;
          }
          const currentAfterFailure = notesRef.current[id];
          const restored = restoreAfterFailedWrite(currentAfterFailure, base, durableNotesRef.current[id]);
          if (restored !== currentAfterFailure) {
            if (restored) {
              notesRef.current[id] = restored;
              setNotes((all) => all.map((n) => (n.id === id ? restored : n)));
            } else {
              delete notesRef.current[id];
              setNotes((all) => all.filter((n) => n.id !== id));
            }
          }
          throw error;
        }
      })
      .catch(() => undefined);
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await api(`/notes/${id}`, { method: 'DELETE', queueIfOffline: true });
    } catch (error) {
      if (!(error instanceof APIError && error.queued)) throw error;
    }
    delete notesRef.current[id];
    delete durableNotesRef.current[id];
    setNotes((all) => all.filter((n) => n.id !== id));
    setRawEdges((all) => all.filter((e) => e.source !== id && e.target !== id));
  }, []);
  const restore = useCallback(async (id: string) => {
    const result = await api<{ history: Array<{ version: number; createdAt: string }> }>(`/notes/${id}/history`);
    const latest = result.history[0];
    if (!latest) {
      window.alert(t('복원할 이전 버전이 없습니다.'));
      return;
    }
    if (
      !window.confirm(
        t('{time}의 버전으로 되돌릴까요? 현재 상태도 기록에 남습니다.', { time: formatDate(latest.createdAt) }),
      )
    )
      return;
    const restored = await api<ThoughtNote>(`/notes/${id}/restore/${latest.version}`, { method: 'POST' });
    durableNotesRef.current[id] = restored;
    notesRef.current[id] = restored;
    setNotes((all) => all.map((n) => (n.id === id ? restored : n)));
  }, []);

  const gravity = useCallback(
    (selectedID?: string) => {
      const selected = selectedID ? flow.getNode(selectedID) : flow.getNodes().find((n) => n.selected);
      if (!selected) return;
      const related = new Set<string>();
      rawEdges.forEach((e) => {
        if (e.source === selected.id) related.add(e.target);
        if (e.target === selected.id) related.add(e.source);
      });
      [...related].forEach((id, index) => {
        const angle = (index / Math.max(1, related.size)) * Math.PI * 2;
        const patch = {
          x: selected.position.x + Math.cos(angle) * 330,
          y: selected.position.y + Math.sin(angle) * 230,
        };
        persist(id, patch);
      });
    },
    [flow, rawEdges, persist],
  );
  /**
   * Opens the panel that holds a thought's connections and its line of thinking,
   * and moves nothing.
   *
   * This used to exist only inside discoverRelated, which also rearranges the
   * canvas — and discoverRelated is reachable only from the "related N" chip,
   * which a thought with no related thoughts does not have. On a fresh canvas
   * that meant the panel could not be opened at all, so lines of thinking were
   * unreachable in the interface that was built to use them. Verified in a
   * browser: write one thought, click it, and there was no way in.
   */
  const openNotePanel = useCallback(async (id: string) => {
    const [result, linked] = await Promise.all([
      api<{ related: RelatedThought[] }>(`/notes/${id}/related?limit=8`),
      api<{ backlinks: Backlink[] }>(`/notes/${id}/backlinks`),
    ]);
    setRelated({ source: id, items: result.related });
    api<{ suggestions: SpaceSuggestion[] }>(`/notes/${id}/space-suggestions`, { silent: true })
      .then((value) => setHomes(value.suggestions))
      .catch(() => setHomes([]));
    setBacklinks(linked.backlinks);
    return result.related;
  }, []);
  const discoverRelated = useCallback(
    async (id: string) => {
      // Gathering is a deliberate act: it pulls the related thoughts around this
      // one. Opening the panel is not, which is why they are separate now.
      const related = await openNotePanel(id);
      const source = flow.getNode(id);
      if (source) {
        related.forEach((item, index) => {
          const angle = (index / Math.max(1, related.length)) * Math.PI * 2;
          persist(item.note.id, {
            x: source.position.x + Math.cos(angle) * 360,
            y: source.position.y + Math.sin(angle) * 245,
          });
        });
      }
    },
    [flow, persist, openNotePanel],
  );
  const openComments = useCallback(async (note: ThoughtNote) => {
    setCommentNote(note);
    setCommentBody('');
    const result = await api<{ comments: NoteComment[] }>(`/notes/${note.id}/comments`);
    setComments(result.comments);
  }, []);
  const postComment = async () => {
    if (!commentNote || !commentBody.trim()) return;
    setCommentBusy(true);
    try {
      const created = await api<NoteComment>(`/notes/${commentNote.id}/comments`, {
        ...json('POST', { body: commentBody }),
        queueIfOffline: true,
      });
      setComments((all) => [...all, created]);
      setCommentBody('');
    } catch (error) {
      if (error instanceof APIError && error.queued) {
        setCommentBody('');
        showInfo(t('댓글을 오프라인 보관함에 넣었습니다. 연결되면 자동으로 게시합니다.'), t('오프라인 저장'));
      }
    } finally {
      setCommentBusy(false);
    }
  };
  const resolveComment = async (comment: NoteComment) => {
    const resolved = !comment.resolvedAt;
    try {
      const updated = await api<NoteComment>(`/comments/${comment.id}/resolve`, {
        ...json('PUT', { resolved }),
        queueIfOffline: true,
      });
      setComments((all) => all.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      if (error instanceof APIError && error.queued)
        setComments((all) =>
          all.map((item) =>
            item.id === comment.id ? { ...item, resolvedAt: resolved ? new Date().toISOString() : undefined } : item,
          ),
        );
      else throw error;
    }
  };
  const deleteComment = async (comment: NoteComment) => {
    if (!window.confirm(t('이 댓글을 삭제할까요?'))) return;
    try {
      await api(`/comments/${comment.id}`, { method: 'DELETE', queueIfOffline: true });
    } catch (error) {
      if (!(error instanceof APIError && error.queued)) throw error;
    }
    setComments((all) => all.filter((item) => item.id !== comment.id));
  };
  const applyConflict = async (mode: 'server' | 'local' | 'merge') => {
    if (!conflict) return;
    if (mode === 'server') {
      await discardOfflineMutation(conflict.offlineMutationId);
      durableNotesRef.current[conflict.latest.id] = conflict.latest;
      notesRef.current[conflict.latest.id] = conflict.latest;
      setNotes((all) => all.map((note) => (note.id === conflict.latest.id ? conflict.latest : note)));
      setConflict(undefined);
      return;
    }
    const desired = {
      ...conflict.local,
      content: mode === 'merge' ? mergeDraft : conflict.local.content,
      version: conflict.latest.version,
    };
    const updated = await api<ThoughtNote>(`/notes/${desired.id}`, json('PUT', noteWritePayload(desired)));
    await discardOfflineMutation(conflict.offlineMutationId);
    durableNotesRef.current[updated.id] = updated;
    notesRef.current[updated.id] = updated;
    setNotes((all) => all.map((note) => (note.id === updated.id ? updated : note)));
    setConflict(undefined);
  };
  useEffect(() => {
    const synced = () => {
      if (activeSpace) void loadCanvas(true);
    };
    const offlineConflict = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const latest = detail?.payload?.latest as ThoughtNote | undefined;
      if (!latest || latest.spaceId !== activeSpace) return;
      let queued: Partial<ThoughtNote> = {};
      try {
        queued = JSON.parse(detail?.item?.body || '{}');
      } catch {
        /* malformed queued payload remains available for retry */
      }
      const current = notesRef.current[latest.id];
      const local = current
        ? { ...latest, ...current, ...queued, id: latest.id, spaceId: latest.spaceId }
        : ({ ...latest, ...queued } as ThoughtNote);
      setConflict({ local, latest, offlineMutationId: detail?.item?.id });
      setMergeDraft(local.content);
    };
    window.addEventListener('umm:offline-sync', synced);
    window.addEventListener('umm:offline-conflict', offlineConflict);
    return () => {
      window.removeEventListener('umm:offline-sync', synced);
      window.removeEventListener('umm:offline-conflict', offlineConflict);
    };
  }, [activeSpace, loadCanvas]);

  const searchTerms = useMemo(() => normalizeSearch(query).split(/\s+/).filter(Boolean), [query]);
  const searchMatches = useMemo(
    () =>
      searchTerms.length === 0
        ? notes
        : notes.filter((note) => {
            const searchable = normalizeSearch(`${note.title} ${note.content}`);
            return searchTerms.every((term) => searchable.includes(term));
          }),
    [notes, searchTerms],
  );
  const visibleSpaces = useMemo(() => {
    const term = normalizeSearch(spaceQuery);
    return [...spaces]
      .filter((space) => !term || normalizeSearch(space.name).includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [spaces, spaceQuery]);
  // The one selected thought, when there is exactly one. A lens over connections
  // needs a place to start, and starting it from an arbitrary member of a
  // multiple selection would pick for the person without telling them.
  const selectedNoteID = useMemo(() => {
    const chosen = nodes.filter((node) => node.selected && node.type === 'postit');
    return chosen.length === 1 ? chosen[0].id : '';
  }, [nodes]);

  // Only lines that were set aside are marked. An open or adopted line is the
  // ordinary state of a thought, and a badge on every note would be wallpaper.
  const setAsideLines = useMemo(() => {
    const byID = new Map(branches.filter((branch) => branch.status === 'abandoned').map((b) => [b.id, b.name]));
    const out: Record<string, string> = {};
    for (const [noteID, branchID] of Object.entries(branchAssignments)) {
      const name = byID.get(branchID);
      if (name) out[noteID] = name;
    }
    return out;
  }, [branches, branchAssignments]);

  useEffect(() => {
    const noteNodes = (visible: ThoughtNote[]) =>
      visible.map((note) => ({
        id: note.id,
        type: 'postit',
        position: { x: note.x, y: note.y },
        // The fade goes on the node wrapper, not on the card inside it. The card
        // carries `animation: note-land ... both`, and an animation's final
        // keyframe beats an inline style for good — setting opacity on the card
        // looks right in the DOM and changes nothing on screen. This was found
        // by an end-to-end test reading computed style; reading the inline
        // attribute had confirmed a fade that was never rendered.
        style: {
          width: note.width,
          height: note.height,
          opacity: lens && !lens.ids.has(note.id) ? 0.22 : 1,
        },
        data: {
          note,
          setAsideLine: setAsideLines[note.id],
          relatedCount: note.relatedCount,
          onGather: discoverRelated,
          onPanel: openNotePanel,
          onPatch: persist,
          onDelete: remove,
          onRestore: restore,
          onComments: openComments,
        },
      }));

    if (!zoomedOut || clusters.length === 0 || searchMatches.length < clusterMinNotes) {
      setNodes(noteNodes(searchMatches));
      return;
    }

    // Zoomed out: draw what the notes add up to. A group becomes one shape
    // covering the ground its members occupy, so the canvas keeps the layout the
    // person built rather than rearranging itself when they zoom.
    const byID = new Map(searchMatches.map((note) => [note.id, note]));
    const grouped = new Set<string>();
    const clusterNodes = clusters
      .map((cluster) => {
        const members = cluster.noteIds.map((id) => byID.get(id)).filter((note): note is ThoughtNote => !!note);
        if (members.length < 2) return undefined;
        members.forEach((note) => grouped.add(note.id));
        const left = Math.min(...members.map((note) => note.x));
        const top = Math.min(...members.map((note) => note.y));
        const right = Math.max(...members.map((note) => note.x + note.width));
        const bottom = Math.max(...members.map((note) => note.y + note.height));
        return {
          id: cluster.id,
          type: 'cluster',
          position: { x: left, y: top },
          style: { width: right - left, height: bottom - top },
          draggable: false,
          data: { label: cluster.label, count: members.length, basis: cluster.basis } satisfies ClusterNodeData,
        };
      })
      .filter((node): node is NonNullable<typeof node> => !!node);

    // Notes in no group stay themselves. They are the outliers, and hiding them
    // would make the zoomed-out view claim the workspace is tidier than it is.
    setNodes([...clusterNodes, ...noteNodes(searchMatches.filter((note) => !grouped.has(note.id)))]);
  }, [
    searchMatches,
    persist,
    remove,
    restore,
    discoverRelated,
    openComments,
    zoomedOut,
    clusters,
    lens,
    setAsideLines,
  ]);
  useEffect(() => {
    const visible = new Set(searchMatches.map((note) => note.id));
    setEdges(
      rawEdges
        .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: edgeStyle,
          // Animation marks where a connection came from, not what it means: a
          // line umm produced should be visibly different from one drawn by hand.
          animated: e.origin === 'dream' || e.origin === 'auto',
          // The generic relation adds nothing to a drawn line, so it stays
          // unlabelled; everything else states what it claims.
          label: e.relation === 'related' ? undefined : relationLabel(e.relation),
          // A connection is only in focus when both ends are. A line at full
          // strength running into a faded thought reads as a link to nothing.
          style: lens && !(lens.ids.has(e.source) && lens.ids.has(e.target)) ? { opacity: 0.15 } : undefined,
        })),
    );
  }, [edgeStyle, rawEdges, searchMatches, lens]);

  /**
   * A lens over connections: everything within `steps` of one thought.
   *
   * The walk itself lives in ../lens so it can be tested on its own; it is the
   * only part of a lens that can be wrong.
   */
  const focusOnConnections = useCallback(
    (noteID: string, steps: number) => {
      setLens({ label: t('연결 {steps}걸음', { steps }), ids: neighbourhood(noteID, rawEdges, steps) });
    },
    [rawEdges, t],
  );

  const shortcutNoteID = useMemo(() => new URLSearchParams(location.search).get('note') || '', [location.search]);
  useEffect(() => {
    if (!shortcutNoteID) {
      focusedShortcut.current = '';
      return;
    }
    if (loading || focusedShortcut.current === shortcutNoteID) return;
    const note = notes.find((item) => item.id === shortcutNoteID);
    if (!note) return;
    focusedShortcut.current = shortcutNoteID;
    setQuery('');
    setNodes((all) => all.map((node) => ({ ...node, selected: node.id === shortcutNoteID })));
    window.requestAnimationFrame(() => {
      void flow.setCenter(note.x + note.width / 2, note.y + note.height / 2, { zoom: 1.08, duration: 500 });
      navigate(location.pathname, { replace: true });
    });
  }, [flow, loading, location.pathname, navigate, notes, setNodes, shortcutNoteID]);

  const createAt = useCallback(
    async (content: string, x: number, y: number) => {
      if (!activeSpace) return;
      const trimmed = content.trim();
      try {
        const created = await api<ThoughtNote>(`/spaces/${activeSpace}/notes`, {
          ...json('POST', {
            content: trimmed,
            title: '',
            color: 'yellow',
            kind: 'thought',
            x,
            y,
            width: 240,
            height: 160,
            rotation: Math.round((Math.random() - 0.5) * 2),
          }),
          queueIfOffline: true,
        });
        durableNotesRef.current[created.id] = created;
        syncNotes([...Object.values(notesRef.current), created]);
        setCapture('');
      } catch (error) {
        if (error instanceof APIError && error.queued) {
          setCapture('');
          showInfo(t('새 생각을 오프라인 보관함에 넣었습니다. 연결되면 캔버스에 나타납니다.'), t('오프라인 저장'));
          return;
        }
        throw error;
      }
    },
    [activeSpace],
  );

  // Imported thoughts are created one at a time so the progress bar reflects
  // real work and one rejected note cannot lose the rest of the batch.
  const importThoughts = useCallback(
    async (thoughts: ImportedThought[], onProgress: (done: number) => void): Promise<ImportThoughtsResult> => {
      if (thoughts.length === 0) return { created: 0, failed: [] };
      if (!activeSpace) return { created: 0, failed: thoughts };
      const viewport = flow.screenToFlowPosition({ x: 140, y: 180 });
      const created: ThoughtNote[] = [];
      const failed: ImportedThought[] = [];
      for (const [index, thought] of thoughts.entries()) {
        const position = importLayout(index, viewport.x, viewport.y);
        try {
          created.push(
            await api<ThoughtNote>(`/spaces/${activeSpace}/notes`, {
              ...json('POST', {
                content: thought.content,
                title: thought.title,
                color: 'yellow',
                kind: 'thought',
                x: position.x,
                y: position.y,
                width: 240,
                height: 160,
                rotation: Math.round((Math.random() - 0.5) * 2),
              }),
              silent: true,
            }),
          );
        } catch {
          // A single rejected note must not abandon the ones that follow.
          failed.push(thought);
        }
        onProgress(index + 1);
      }
      if (created.length > 0) {
        for (const note of created) durableNotesRef.current[note.id] = note;
        syncNotes([...Object.values(notesRef.current), ...created]);
        showSuccess(t('{count}개의 생각을 캔버스에 붙였습니다.', { count: created.length }), t('가져오기 완료'));
      }
      return { created: created.length, failed };
    },
    [activeSpace, flow, t],
  );

  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void createAt('', point.x, point.y);
    },
    [flow, createAt],
  );
  const connect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      try {
        const created = await api<ThoughtEdge>(`/spaces/${activeSpace}/edges`, {
          ...json('POST', { source: connection.source, target: connection.target, relation: drawRelation }),
          queueIfOffline: true,
        });
        setRawEdges((all) => [...all, created]);
        setEdges((all) => addEdge({ ...connection, id: created.id, type: edgeStyle }, all));
      } catch (error) {
        if (error instanceof APIError && error.queued) {
          showInfo(t('연결을 오프라인 보관함에 넣었습니다.'), t('오프라인 저장'));
          return;
        }
        throw error;
      }
    },
    [activeSpace, edgeStyle, drawRelation],
  );
  // Ask umm to propose connections. It writes them as inferred edges, so the
  // canvas shows them immediately and this list is the review queue.
  const requestSuggestions = useCallback(async () => {
    if (!activeSpace) return;
    setSuggestBusy(true);
    try {
      const result = await api<SuggestionResult>(`/spaces/${activeSpace}/links/suggest`, json('POST', {}));
      if (result.outcome === 'suggested') {
        setSuggestions(result.edges);
        setRawEdges((all) => [...all, ...result.edges]);
        setSuggestOpen(true);
        return;
      }
      // A quiet result needs to say which kind of quiet it is. "Nothing found"
      // and "umm declined to guess" call for completely different responses.
      if (result.outcome === 'backend-not-semantic') {
        showInfo(
          t(
            '지금 임베딩이 뜻이 아니라 겹치는 단어를 재고 있어 추천을 만들지 않았습니다. 관리자 → AI Gateway에서 임베딩 모델을 설정하면 켜집니다.',
          ),
          t('추천을 건너뛰었습니다'),
        );
        return;
      }
      if (result.outcome === 'too-few-notes') {
        showInfo(t('무엇이 유난히 가까운지 판단하기에 생각이 아직 적습니다.'), t('추천을 건너뛰었습니다'));
        return;
      }
      showInfo(
        t('{count}개 짝을 살펴봤지만 눈에 띄게 가까운 것이 없었습니다.', { count: result.considered }),
        t('추천할 연결이 없습니다'),
      );
    } finally {
      setSuggestBusy(false);
    }
  }, [activeSpace, t]);

  const answerSuggestion = useCallback(async (edgeID: string, keep: boolean) => {
    if (keep) {
      const accepted = await api<ThoughtEdge>(`/edges/${edgeID}/accept`, json('POST', {}));
      setRawEdges((all) => all.map((edge) => (edge.id === edgeID ? accepted : edge)));
    } else {
      await api<void>(`/edges/${edgeID}`, { method: 'DELETE' });
      setRawEdges((all) => all.filter((edge) => edge.id !== edgeID));
      setEdges((all) => all.filter((edge) => edge.id !== edgeID));
    }
    setSuggestions((all) => all.filter((edge) => edge.id !== edgeID));
  }, []);

  // Filing a thought into another space. Connections are scoped to a space and
  // both endpoints must be in it, so the server reports how many it had to
  // remove — the person hears about that rather than discovering it later.
  const fileThought = useCallback(
    async (noteID: string, spaceID: string, spaceName: string) => {
      setFiling(spaceID);
      try {
        const result = await api<{ note: ThoughtNote; removedEdges: number }>(
          `/notes/${noteID}/move`,
          json('POST', { spaceId: spaceID }),
        );
        setNotes((all) => all.filter((note) => note.id !== noteID));
        setRawEdges((all) => all.filter((edge) => edge.source !== noteID && edge.target !== noteID));
        setRelated(undefined);
        setHomes([]);
        showSuccess(
          result.removedEdges > 0
            ? t('{space}(으)로 옮겼습니다. 공간이 달라 연결 {count}개는 정리했습니다.', {
                space: spaceName,
                count: result.removedEdges,
              })
            : t('{space}(으)로 옮겼습니다.', { space: spaceName }),
          t('생각 정리'),
        );
      } finally {
        setFiling('');
      }
    },
    [t],
  );

  // Clusters are fetched when the canvas crosses into the zoomed-out view and
  // then reused, because the grouping does not change as the person keeps
  // zooming and refetching on every wheel tick would be a request storm.
  useEffect(() => {
    if (!zoomedOut || !activeSpace) return;
    let cancelled = false;
    api<{ clusters: Cluster[] }>(`/spaces/${activeSpace}/clusters`, { silent: true })
      .then((result) => {
        if (!cancelled) setClusters(result.clusters);
      })
      .catch(() => {
        if (!cancelled) setClusters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [zoomedOut, activeSpace, notes.length]);

  // Cluster shapes are not draggable, so only post-its reach these — but the
  // handler types follow the node union the canvas is declared with.
  const onDragStart: OnNodeDrag<CanvasNode> = (_, node) => {
    dragStart.current[node.id] = { ...node.position };
  };
  const onDragStop: OnNodeDrag<CanvasNode> = (_, node) => {
    const before = dragStart.current[node.id];
    const after = { ...node.position };
    if (before && (before.x !== after.x || before.y !== after.y)) {
      undo.current.push({ id: node.id, before, after });
      redo.current = [];
    }
    persist(node.id, { x: after.x, y: after.y });
  };

  const focusSearchResult = useCallback(
    (step = 1) => {
      if (searchMatches.length === 0) return;
      const next = (searchIndex + step + searchMatches.length) % searchMatches.length;
      setSearchIndex(next);
      const id = searchMatches[next].id;
      setNodes((all) => all.map((node) => ({ ...node, selected: node.id === id })));
      window.requestAnimationFrame(
        () => void flow.fitView({ nodes: [{ id }], duration: 350, padding: 1.4, maxZoom: 1.25 }),
      );
    },
    [flow, searchIndex, searchMatches, setNodes],
  );

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (document.querySelector('[role="dialog"]')) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLocaleLowerCase();
      if (!editing && mod && key === 'f') {
        event.preventDefault();
        document.getElementById('thought-search')?.focus();
        return;
      }
      if (!editing && !mod && !event.altKey && key === 'n') {
        event.preventDefault();
        document.getElementById('quick-thought')?.focus();
        return;
      }
      if (!editing && !mod && !event.altKey && event.key === '/') {
        event.preventDefault();
        document.getElementById('thought-search')?.focus();
        return;
      }
      if (!editing && (event.key === 'Delete' || event.key === 'Backspace')) {
        const selected = flow
          .getNodes()
          .filter((node) => node.selected)
          .map((node) => node.id);
        if (selected.length === 0) return;
        event.preventDefault();
        if (window.confirm(t('선택한 생각 {count}개를 삭제할까요?', { count: selected.length })))
          void Promise.all(selected.map(remove));
        return;
      }
      if (!editing && mod && key === 'a') {
        event.preventDefault();
        setNodes((all) => all.map((node) => ({ ...node, selected: true })));
        return;
      }
      if (!editing && !mod && !event.altKey && key === 'f') {
        event.preventDefault();
        void flow.fitView({ duration: 400, padding: 0.25 });
        return;
      }
      if (!editing && event.key === 'Escape') {
        setQuery('');
        setSearchIndex(-1);
        setRelated(undefined);
        setNodes((all) => all.map((node) => ({ ...node, selected: false })));
        return;
      }
      if (!editing && mod && key === 'z') {
        event.preventDefault();
        const action = event.shiftKey ? redo.current.pop() : undo.current.pop();
        if (!action) return;
        const position = event.shiftKey ? action.after : action.before;
        persist(action.id, position);
        setNodes((all) => all.map((n) => (n.id === action.id ? { ...n, position } : n)));
        (event.shiftKey ? undo.current : redo.current).push(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow, persist, remove, setNodes]);

  // The web app manifest registers umm as a share target, so another app can
  // hand a link or a snippet straight to the capture box. The parameters are
  // consumed once so a reload does not re-fill the input.
  useEffect(() => {
    const shared = [searchParams.get('title'), searchParams.get('text'), searchParams.get('url')]
      .map((value) => value?.trim())
      .filter(Boolean);
    if (shared.length === 0) return;
    setCapture(shared.join('\n'));
    const next = new URLSearchParams(searchParams);
    for (const key of ['title', 'text', 'url']) next.delete(key);
    setSearchParams(next, { replace: true });
    window.requestAnimationFrame(() => document.getElementById('quick-thought')?.focus());
  }, [searchParams, setSearchParams]);

  const captureKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && capture.trim()) {
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      void createAt(capture, center.x - 120, center.y - 80);
    }
  };
  const openSpace = (id: string) => {
    setQuery('');
    setSpaceQuery('');
    navigate(`/space/${id}`);
  };
  const addSpace = async () => {
    const name = newSpaceName.trim();
    if (!name) return;
    setSpaceError('');
    setSpaceBusy('new');
    try {
      const created = await api<Space>('/spaces', json('POST', { name }));
      setSpaces((all) => [...all, created]);
      setSpaceDrafts((all) => ({ ...all, [created.id]: created.name }));
      setNewSpaceName('');
      setSpaceManagerOpen(false);
      openSpace(created.id);
    } catch (error) {
      setSpaceError(error instanceof Error ? error.message : t('공간을 만들지 못했습니다.'));
    } finally {
      setSpaceBusy('');
    }
  };
  const renameSpace = async (space: Space) => {
    const name = (spaceDrafts[space.id] || '').trim();
    if (!name || name === space.name) return;
    setSpaceError('');
    setSpaceBusy(space.id);
    try {
      const updated = await api<Space>(`/spaces/${space.id}`, json('PUT', { name, aiExcluded: space.aiExcluded }));
      setSpaces((all) => all.map((item) => (item.id === space.id ? updated : item)));
      setSpaceDrafts((all) => ({ ...all, [space.id]: updated.name }));
    } catch (error) {
      setSpaceError(error instanceof Error ? error.message : t('공간 이름을 저장하지 못했습니다.'));
    } finally {
      setSpaceBusy('');
    }
  };
  const toggleSpaceAI = async (space: Space, aiExcluded: boolean) => {
    setSpaceError('');
    setSpaceBusy(`ai:${space.id}`);
    try {
      const updated = await api<Space>(`/spaces/${space.id}`, json('PUT', { name: space.name, aiExcluded }));
      setSpaces((all) => all.map((item) => (item.id === space.id ? updated : item)));
    } catch (error) {
      setSpaceError(error instanceof Error ? error.message : t('Dream 분석 설정을 저장하지 못했습니다.'));
    } finally {
      setSpaceBusy('');
    }
  };
  const deleteSpace = async () => {
    if (!deleteCandidate || deleteConfirmation !== deleteCandidate.name) return;
    setSpaceError('');
    setSpaceBusy(`delete:${deleteCandidate.id}`);
    try {
      await api(`/spaces/${deleteCandidate.id}`, { method: 'DELETE' });
      const result = await api<{ spaces: Space[] }>('/spaces');
      setSpaces(result.spaces);
      setSpaceDrafts(Object.fromEntries(result.spaces.map((space) => [space.id, space.name])));
      const next = result.spaces.find((space) => space.id !== deleteCandidate.id) || result.spaces[0];
      setDeleteCandidate(undefined);
      setDeleteConfirmation('');
      if (next && activeSpace === deleteCandidate.id) openSpace(next.id);
    } catch (error) {
      setSpaceError(error instanceof Error ? error.message : t('공간을 삭제하지 못했습니다.'));
    } finally {
      setSpaceBusy('');
    }
  };
  const clusterThoughts = async () => {
    const { clusters } = await api<{ clusters: Cluster[] }>(`/spaces/${activeSpace}/clusters`);
    clusters.forEach((cluster, clusterIndex) =>
      cluster.noteIds.forEach((id, noteIndex) =>
        persist(id, { x: clusterIndex * 620 + (noteIndex % 2) * 270, y: Math.floor(noteIndex / 2) * 205 }),
      ),
    );
    if (clusters.length === 0) window.alert(t('아직 뚜렷한 생각 군집이 없습니다. 조금 더 생각을 붙여보세요.'));
  };
  const assist = async (mode: string) => {
    const selected = flow
      .getNodes()
      .filter((n) => n.selected)
      .map((n) => n.id);
    if (selected.length === 0) {
      showInfo(t('AI와 발전시킬 생각을 하나 이상 선택해 주세요.'), t('생각 선택 필요'));
      return;
    }
    setAIBusy(true);
    try {
      setAIResult(await api('/ai/assist', json('POST', { noteIds: selected, mode })));
    } catch {
      /* API 알림에서 안내합니다. */
    } finally {
      setAIBusy(false);
    }
  };
  const loadMembers = async () => {
    const v = await api<{ members: SpaceMember[]; canManage: boolean }>(`/spaces/${activeSpace}/members`);
    setMembers(v.members);
    setCanManage(v.canManage);
  };
  const openShare = async () => {
    await loadMembers();
    setShareOpen(true);
  };
  const share = async () => {
    const v = await api<{ required: boolean; status: string }>(
      `/spaces/${activeSpace}/members`,
      json('POST', { username: shareUser, permission: sharePermission }),
    );
    setShareMessage(
      v.required ? t('팀장 검토를 요청했습니다. 승인되면 자동으로 공유됩니다.') : t('공간을 공유했습니다.'),
    );
    setShareUser('');
    await loadMembers();
  };
  const removeMember = async (id: string) => {
    await api(`/spaces/${activeSpace}/members/${id}`, { method: 'DELETE' });
    await loadMembers();
  };
  const ensureExport = async (format: string) => {
    const response = await fetch(`/api/v1/spaces/${activeSpace}/export/authorize?format=${format}`, {
      credentials: 'same-origin',
    });
    if (response.ok) return true;
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.code === 'approval_required') {
      const request = await api<{ required: boolean; status: string }>(
        '/approvals',
        json('POST', {
          resourceType: 'space',
          resourceId: activeSpace,
          action: 'export',
          comment: t('{format} 내보내기 요청', { format }),
        }),
      );
      showInfo(
        request.required
          ? t('팀장 검토를 요청했습니다. 승인 후 24시간 동안 내보낼 수 있습니다.')
          : t('내보내기가 허용되었습니다.'),
        t('내보내기 승인'),
      );
      return !request.required;
    }
    throw new Error(payload.error || t('내보내기 권한을 확인하지 못했습니다.'));
  };
  const downloadMarkdown = async () => {
    if (!(await ensureExport('markdown'))) return false;
    const response = await fetch(`/api/v1/spaces/${activeSpace}/export/markdown`, { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || t('Markdown을 만들지 못했습니다.'));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `umm-${activeName}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  };
  const canvasImage = async () => {
    const target = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    const allNodes = flow.getNodes();
    if (!target) throw new Error(t('캔버스를 찾을 수 없습니다.'));
    if (allNodes.length === 0) throw new Error(t('내보낼 메모가 없습니다.'));
    const { toPng } = await import('html-to-image');
    const bounds = getNodesBounds(allNodes);
    const aspect = Math.max(0.4, Math.min(2.5, (bounds.width || 1) / (bounds.height || 1)));
    const imageWidth = aspect >= 1 ? 2000 : Math.max(900, Math.round(2000 * aspect));
    const imageHeight = aspect >= 1 ? Math.max(900, Math.round(2000 / aspect)) : 2000;
    const viewport = getViewportForBounds(bounds, imageWidth, imageHeight, 0.1, 2, 0.1);
    return toPng(target, {
      backgroundColor: '#f8f5ee',
      width: imageWidth,
      height: imageHeight,
      pixelRatio: 1.5,
      cacheBust: true,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });
  };
  const downloadImage = async () => {
    if (!(await ensureExport('image'))) return false;
    const data = await canvasImage();
    const anchor = document.createElement('a');
    anchor.href = data;
    anchor.download = `umm-${activeName}.png`;
    anchor.click();
    return true;
  };
  const downloadPDF = async () => {
    if (!(await ensureExport('pdf'))) return false;
    const data = await canvasImage();
    const [{ jsPDF }, image] = await Promise.all([
      import('jspdf'),
      new Promise<HTMLImageElement>((resolve, reject) => {
        const next = new Image();
        next.onload = () => resolve(next);
        next.onerror = () => reject(new Error(t('PDF용 이미지를 준비하지 못했습니다.')));
        next.src = data;
      }),
    ]);
    const landscape = image.naturalWidth >= image.naturalHeight;
    const pdf = new jsPDF({
      orientation: landscape ? 'landscape' : 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const scale = Math.min(
      (pageWidth - margin * 2) / image.naturalWidth,
      (pageHeight - margin * 2) / image.naturalHeight,
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    pdf.addImage(data, 'PNG', (pageWidth - width) / 2, (pageHeight - height) / 2, width, height, undefined, 'FAST');
    pdf.save(`umm-${activeName.replace(/[\\/:*?"<>|]/g, '-')}.pdf`);
    return true;
  };
  const runExport = async (kind: string, label: string, action: () => Promise<boolean>) => {
    if (exportBusy) return;
    setExportBusy(kind);
    showInfo(t('{label} 파일을 준비하고 있습니다.', { label }), t('내보내기'));
    try {
      if (await action()) showSuccess(t('{label} 파일 다운로드를 시작했습니다.', { label }), t('내보내기 완료'));
    } catch (error) {
      showError(
        error instanceof Error ? error.message : t('{label} 파일을 만들지 못했습니다.', { label }),
        t('내보내기 실패'),
        `export:${kind}`,
      );
    } finally {
      setExportBusy('');
    }
  };
  const dismissDream = async () => {
    if (!morningDream) return;
    writeSessionStorage(`dream:${morningDream.dreamId}`, 'seen');
    await api(`/dreams/${morningDream.dreamId}/feedback`, json('POST', { action: 'exposed' })).catch(() => undefined);
    setMorningDream(undefined);
  };
  const reviewDream = async () => {
    if (!morningDream) return;
    const id = morningDream.dreamId;
    await dismissDream();
    navigate(`/dreams?focus=${id}`);
  };
  const activeName = spaces.find((s) => s.id === activeSpace)?.name || 'My Space';

  return (
    <div className="canvas-page">
      {loading && (
        <div className="canvas-loading" role="status" aria-label={t('생각 불러오는 중')}>
          <Loader color="grape" />
        </div>
      )}
      {listView ? (
        <ScrollArea className="canvas-linear-view" type="auto">
          <main aria-label={t('생각 선형 목록')}>
            <Group justify="space-between" mb="lg">
              <div>
                <Title order={2}>{t('생각 목록')}</Title>
                <Text c="dimmed" size="sm">
                  {t('키보드와 화면 읽기 도구로 탐색하기 쉬운 보기입니다.')}
                </Text>
              </div>
              <Button variant="light" onClick={() => setListView(false)}>
                {t('캔버스로 돌아가기')}
              </Button>
            </Group>
            <Stack role="list" gap="sm">
              {searchMatches.map((note) => (
                <Card role="listitem" key={note.id} withBorder radius="lg" p="lg">
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <div>
                      <Group gap="xs">
                        <Badge variant="light">{note.kind}</Badge>
                        {note.source === 'dream' && (
                          <Badge color="grape" variant="light">
                            Dream
                          </Badge>
                        )}
                        <Text size="xs" c="dimmed">
                          {formatDate(note.updatedAt)}
                        </Text>
                      </Group>
                      <Text fw={650} mt="sm">
                        {note.title || note.content || t('내용 없는 생각')}
                      </Text>
                    </div>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconMessageCircle size={14} />}
                        onClick={() => void openComments(note)}
                      >
                        {t('댓글')}
                      </Button>
                      <Button
                        size="xs"
                        onClick={() => {
                          setListView(false);
                          window.requestAnimationFrame(
                            () =>
                              void flow.setCenter(note.x + note.width / 2, note.y + note.height / 2, {
                                zoom: 1.08,
                                duration: 400,
                              }),
                          );
                        }}
                      >
                        {t('캔버스에서 보기')}
                      </Button>
                    </Group>
                  </Group>
                </Card>
              ))}
            </Stack>
          </main>
        </ScrollArea>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onNodeDragStart={onDragStart}
          onNodeDragStop={onDragStop}
          onPaneClick={(event) => {
            if (event.detail === 2) onPaneDoubleClick(event);
          }}
          onMove={(_, viewport) => {
            // Only the crossing matters, so state changes once per crossing
            // rather than on every wheel tick.
            const out = viewport.zoom < clusterZoom;
            setZoomedOut((current) => (current === out ? current : out));
          }}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.15}
          maxZoom={2.2}
          deleteKeyCode={null}
          selectionOnDrag
          panOnScroll
        >
          <Background variant={BackgroundVariant.Dots} color="transparent" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(node) => palette[(node.data as PostItData | undefined)?.note?.color || 'yellow'] || '#ddd'}
            maskColor="rgba(245,242,234,.7)"
          />
        </ReactFlow>
      )}
      <Paper className="canvas-toolbar" radius="xl" p={7}>
        <Group gap={6} wrap="nowrap">
          <Menu shadow="md" width={300} position="bottom-start">
            <Menu.Target>
              <Button
                className="space-switcher"
                variant="light"
                color="yellow.8"
                size="compact-sm"
                rightSection={<IconChevronDown size={14} />}
                style={{ textTransform: 'none' }}
              >
                {activeName}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{t('공간 {count}개', { count: spaces.length })}</Menu.Label>
              <div className="space-menu-search">
                <TextInput
                  value={spaceQuery}
                  onChange={(event) => setSpaceQuery(event.currentTarget.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  leftSection={<IconSearch size={15} />}
                  placeholder={t('공간 검색')}
                  size="xs"
                />
              </div>
              <ScrollArea.Autosize mah={260} type="auto">
                {visibleSpaces.map((space) => (
                  <Menu.Item
                    key={space.id}
                    leftSection={<span className="space-dot" style={{ background: space.color }} />}
                    rightSection={space.id === activeSpace ? <IconCheck size={15} /> : undefined}
                    onClick={() => openSpace(space.id)}
                  >
                    {space.name}
                  </Menu.Item>
                ))}
                {visibleSpaces.length === 0 && (
                  <Text size="xs" c="dimmed" ta="center" py="md">
                    {t('일치하는 공간이 없습니다.')}
                  </Text>
                )}
              </ScrollArea.Autosize>
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconSettings size={16} />}
                onClick={() => {
                  setSpaceError('');
                  setSpaceManagerOpen(true);
                }}
              >
                {t('공간 관리')}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlus size={16} />}
                onClick={() => {
                  setSpaceError('');
                  setSpaceManagerOpen(true);
                }}
              >
                {t('새 공간 만들기')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <TextInput
            id="thought-search"
            className="thought-search"
            aria-label={t('생각 검색')}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setSearchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                focusSearchResult(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
                setSearchIndex(-1);
              }
            }}
            leftSection={<IconSearch size={17} />}
            rightSection={
              query ? (
                <Group gap={3} wrap="nowrap">
                  <Badge size="xs" variant="light" color={searchMatches.length ? 'grape' : 'red'}>
                    {searchMatches.length}
                  </Badge>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    onClick={() => {
                      setQuery('');
                      setSearchIndex(-1);
                    }}
                    aria-label={t('검색어 지우기')}
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </Group>
              ) : null
            }
            rightSectionWidth={query ? 66 : undefined}
            placeholder={t('생각 검색  /')}
            variant="filled"
          />
          <Group className="canvas-toolbar-actions" gap={2} wrap="nowrap">
            <Tooltip label={t('새로 그리는 연결의 종류')}>
              <Select
                className="canvas-relation-select"
                size="xs"
                w={116}
                withCheckIcon={false}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                aria-label={t('새로 그리는 연결의 종류')}
                value={drawRelation}
                onChange={(value) => {
                  if (!value) return;
                  setDrawRelation(value as EdgeRelation);
                  writeLocalStorage('umm:draw-relation', value);
                }}
                data={relationOptions.map((relation) => ({ value: relation, label: relationLabel(relation) }))}
              />
            </Tooltip>
            <Tooltip label={t('연결 추천 받기')}>
              <ActionIcon
                className="canvas-action"
                variant="subtle"
                color="dark"
                loading={suggestBusy}
                onClick={() => void requestSuggestions()}
                aria-label={t('연결 추천 받기')}
              >
                <IconSparkles size={19} />
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom" withinPortal width={230}>
              <Menu.Target>
                <Tooltip label={t('한 갈래만 보기')}>
                  <ActionIcon
                    className="canvas-action"
                    variant={lens ? 'filled' : 'subtle'}
                    color="dark"
                    aria-label={t('한 갈래만 보기')}
                    aria-pressed={!!lens}
                  >
                    <IconFocus2 size={19} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                {lens && <Menu.Item onClick={() => setLens(undefined)}>{t('전체 보기')}</Menu.Item>}
                {branches.length > 0 && <Menu.Label>{t('생각의 갈래')}</Menu.Label>}
                {branches.map((branch) => (
                  <Menu.Item
                    key={branch.id}
                    onClick={() =>
                      setLens({
                        label: branch.name,
                        ids: new Set(
                          Object.entries(branchAssignments)
                            .filter(([, id]) => id === branch.id)
                            .map(([note]) => note),
                        ),
                      })
                    }
                  >
                    {branch.name}
                  </Menu.Item>
                ))}
                {/* A lens over connections needs one thought to start from, so
                    it appears only when exactly one is selected. Offering it
                    greyed out would be a menu item that never works. */}
                {selectedNoteID ? (
                  <>
                    <Menu.Label>{t('선택한 생각에서')}</Menu.Label>
                    {[1, 2, 3].map((steps) => (
                      <Menu.Item key={steps} onClick={() => focusOnConnections(selectedNoteID, steps)}>
                        {t('연결 {steps}걸음', { steps })}
                      </Menu.Item>
                    ))}
                  </>
                ) : (
                  <Menu.Label>{t('생각을 하나 고르면 연결로도 좁힐 수 있습니다')}</Menu.Label>
                )}
              </Menu.Dropdown>
            </Menu>
            <Tooltip label={listView ? t('공간 캔버스 보기') : t('접근 가능한 선형 목록')}>
              <ActionIcon
                className="canvas-action"
                variant={listView ? 'filled' : 'subtle'}
                color="dark"
                onClick={() => setListView((value) => !value)}
                aria-label={t('생각 보기 전환')}
                aria-pressed={listView}
              >
                <IconList size={19} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('공간 공유')}>
              <ActionIcon
                className="canvas-action"
                variant="subtle"
                color="dark"
                onClick={() => void openShare()}
                aria-label={t('공간 공유')}
              >
                <IconShare size={19} />
              </ActionIcon>
            </Tooltip>
            <Menu shadow="md">
              <Menu.Target>
                <Tooltip label={t('내보내기')}>
                  <ActionIcon
                    className="canvas-action"
                    loading={!!exportBusy}
                    variant="subtle"
                    color="dark"
                    aria-label={t('내보내기')}
                  >
                    <IconDownload size={19} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  disabled={!!exportBusy}
                  leftSection={<IconMarkdown size={16} />}
                  onClick={() => void runExport('markdown', 'Markdown', downloadMarkdown)}
                >
                  Markdown
                </Menu.Item>
                <Menu.Item
                  disabled={!!exportBusy}
                  leftSection={<IconPhoto size={16} />}
                  onClick={() => void runExport('image', t('PNG 이미지'), downloadImage)}
                >
                  Image (PNG)
                </Menu.Item>
                <Menu.Item
                  disabled={!!exportBusy}
                  leftSection={<IconFileTypePdf size={16} />}
                  onClick={() => void runExport('pdf', 'PDF', downloadPDF)}
                >
                  {t('PDF 다운로드')}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<IconFileImport size={16} />} onClick={() => setImportOpen(true)}>
                  {t('마크다운 가져오기')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Menu shadow="md">
              <Menu.Target>
                <Tooltip label={t('선택한 생각 발전시키기')}>
                  <ActionIcon
                    className="canvas-action"
                    loading={aiBusy}
                    variant="subtle"
                    color="grape"
                    aria-label={t('AI 생각 도구')}
                  >
                    <IconBrain size={20} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{t('AI는 조용히 도와줍니다')}</Menu.Label>
                {aiTools.map(([mode, label]) => (
                  <Menu.Item key={mode} onClick={() => void assist(mode)}>
                    {t(label)}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Tooltip label={t('관련 생각 군집 모으기')}>
              <ActionIcon
                className="canvas-action"
                variant="subtle"
                color="blue"
                onClick={() => void clusterThoughts()}
                aria-label={t('생각 군집')}
              >
                <IconLayoutGrid size={20} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('직접 연결한 생각 모으기')}>
              <ActionIcon
                className="canvas-action"
                variant="subtle"
                color="grape"
                onClick={() => gravity()}
                aria-label="Thought Gravity"
              >
                <IconFocusCentered size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Menu shadow="md" position="bottom-end">
            <Menu.Target>
              <ActionIcon
                className="canvas-mobile-tools"
                loading={!!exportBusy}
                variant="subtle"
                color="dark"
                aria-label={t('캔버스 도구')}
              >
                <IconDots size={21} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconList size={17} />} onClick={() => setListView((value) => !value)}>
                {listView ? t('캔버스 보기') : t('선형 목록 보기')}
              </Menu.Item>
              <Menu.Item leftSection={<IconShare size={17} />} onClick={() => void openShare()}>
                {t('공간 공유')}
              </Menu.Item>
              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item leftSection={<IconDownload size={17} />}>{t('내보내기')}</Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  <Menu.Item
                    disabled={!!exportBusy}
                    leftSection={<IconMarkdown size={16} />}
                    onClick={() => void runExport('markdown', 'Markdown', downloadMarkdown)}
                  >
                    Markdown
                  </Menu.Item>
                  <Menu.Item
                    disabled={!!exportBusy}
                    leftSection={<IconPhoto size={16} />}
                    onClick={() => void runExport('image', t('PNG 이미지'), downloadImage)}
                  >
                    Image (PNG)
                  </Menu.Item>
                  <Menu.Item
                    disabled={!!exportBusy}
                    leftSection={<IconFileTypePdf size={16} />}
                    onClick={() => void runExport('pdf', 'PDF', downloadPDF)}
                  >
                    {t('PDF 다운로드')}
                  </Menu.Item>
                </Menu.Sub.Dropdown>
              </Menu.Sub>
              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item leftSection={<IconBrain size={17} />}>{t('AI 생각 도구')}</Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  {aiTools.map(([mode, label]) => (
                    <Menu.Item key={mode} onClick={() => void assist(mode)}>
                      {t(label)}
                    </Menu.Item>
                  ))}
                </Menu.Sub.Dropdown>
              </Menu.Sub>
              <Menu.Item leftSection={<IconLayoutGrid size={17} />} onClick={() => void clusterThoughts()}>
                {t('생각 군집 모으기')}
              </Menu.Item>
              <Menu.Item leftSection={<IconFocusCentered size={17} />} onClick={() => gravity()}>
                {t('연결한 생각 모으기')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Paper>
      {!loading && notes.length === 0 && (
        <div className="onboarding-hint">
          <div>
            <IconSparkles size={30} stroke={1.4} />
            <Text fz="lg" fw={650} mt="sm">
              {t('여기 아무 곳이나 더블클릭 해보세요.')}
            </Text>
            <Text c="dimmed" mt={4}>
              {t('또는 아래에 생각을 바로 적어보세요.')}
            </Text>
          </div>
        </div>
      )}
      {!loading && searchTerms.length > 0 && (
        <Paper className="search-summary glass" radius="xl" px="md" py={7} role="status" aria-live="polite">
          <Text size="sm" fw={650}>
            {searchMatches.length === 0
              ? t('일치하는 생각이 없습니다.')
              : t('{count}개의 생각을 찾았습니다.', { count: searchMatches.length })}
          </Text>
          {searchMatches.length > 0 && (
            <Text size="xs" c="dimmed">
              {t('Enter로 결과 이동')}
              {searchIndex >= 0 ? ` · ${searchIndex + 1}/${searchMatches.length}` : ''}
            </Text>
          )}
        </Paper>
      )}
      {!loading && notes.length > 0 && searchTerms.length > 0 && searchMatches.length === 0 && (
        <div className="onboarding-hint">
          <div>
            <IconSearch size={30} stroke={1.4} />
            <Text fz="lg" fw={650} mt="sm">
              {t('검색 결과가 없습니다.')}
            </Text>
            <Text c="dimmed" mt={4}>
              {t('다른 단어를 입력하거나 Esc로 검색을 지워보세요.')}
            </Text>
          </div>
        </div>
      )}
      <Paper className="quick-capture" radius="xl" p={7}>
        <TextInput
          id="quick-thought"
          aria-label={t('새 생각')}
          value={capture}
          onChange={(e) => setCapture(e.currentTarget.value)}
          onKeyDown={captureKey}
          placeholder={t('생각을 입력하고 Enter로 붙이세요')}
          variant="unstyled"
          px="sm"
          rightSection={
            <ActionIcon
              variant="filled"
              color="dark"
              radius="xl"
              disabled={!capture.trim()}
              onClick={() => {
                const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
                void createAt(capture, center.x - 120, center.y - 80);
              }}
              aria-label={t('생각 붙이기')}
            >
              <IconArrowRight size={18} />
            </ActionIcon>
          }
        />
      </Paper>
      {morningDream && (
        <div className="morning-overlay">
          <Paper radius="xl" p={{ base: 'xl', sm: 40 }} maw={520} mx="md" className="glass" ta="center">
            <IconMoonStars size={34} color="#76628f" />
            <Text size="sm" fw={700} c="grape.7" tt="uppercase" mt="sm">
              Dream
            </Text>
            <Text fz={24} fw={660} mt="md">
              {t('어젯밤, 당신의 생각이 꿈을 꾸었습니다.')}
            </Text>
            <Text fz="lg" lh={1.65} mt="lg">
              {morningDream.content}
            </Text>
            <Text size="sm" c="dimmed" mt="md">
              {t('원본 생각을 확인한 뒤 캔버스에 남길지 선택할 수 있습니다.')}
            </Text>
            <Group justify="center" mt="xl">
              <Button variant="subtle" color="gray" onClick={() => void dismissDream()}>
                {t('나중에')}
              </Button>
              <Button variant="light" color="grape" onClick={() => void reviewDream()}>
                {t('Dream 검토하기')}
              </Button>
            </Group>
          </Paper>
        </div>
      )}
      {lens && (
        <Paper className="lens-banner glass" radius="xl" p="xs" px="md">
          <Group gap="xs" wrap="nowrap">
            <IconFocus2 size={16} />
            <Text size="sm" fw={600}>
              {lens.label}
            </Text>
            <Text size="xs" c="dimmed">
              {/* The count is the honest part. Dimming without it lets a canvas
                  look emptier than it is and hides how much was set aside. */}
              {t('{focused}개에 집중 · {dimmed}개는 흐리게 두었습니다', {
                focused: searchMatches.filter((note) => lens.ids.has(note.id)).length,
                dimmed: searchMatches.filter((note) => !lens.ids.has(note.id)).length,
              })}
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setLens(undefined)}>
              {t('전체 보기')}
            </Button>
          </Group>
        </Paper>
      )}
      {related && (
        <Paper className="related-panel glass" radius="lg" p="md">
          <Group justify="space-between">
            <Text fw={700}>{t('생각 연결')}</Text>
            <ActionIcon
              variant="subtle"
              aria-label={t('연결 패널 닫기')}
              onClick={() => {
                setRelated(undefined);
                setBacklinks([]);
              }}
            >
              <IconX size={16} />
            </ActionIcon>
          </Group>
          {homes.length > 0 && related && (
            <>
              <Text size="xs" fw={700} c="teal.7" mt="md">
                {t('다른 공간으로 옮기기')}
              </Text>
              <Text size="xs" c="dimmed">
                {homes[0].basis === 'meaning'
                  ? t('내용이 가까운 순서입니다.')
                  : t('임베딩이 의미를 판별하지 못해 최근 작업한 순서로 보여 줍니다.')}
              </Text>
              <Stack gap={6} mt="xs">
                {homes.map((home) => (
                  <Button
                    key={home.space.id}
                    size="xs"
                    variant="light"
                    color="teal"
                    justify="space-between"
                    loading={filing === home.space.id}
                    onClick={() => void fileThought(related.source, home.space.id, home.space.name)}
                    rightSection={
                      home.basis === 'meaning' ? <Text size="xs">{Math.round(home.score * 100)}%</Text> : null
                    }
                  >
                    {home.space.name}
                  </Button>
                ))}
              </Stack>
            </>
          )}
          {related && activeSpace && (
            <BranchPanel
              spaceId={activeSpace}
              noteId={related.source}
              branches={branches}
              assignments={branchAssignments}
              onChanged={() => void loadBranches()}
              onFocus={(label, ids) => setLens({ label, ids: new Set(ids) })}
            />
          )}
          {backlinks.length > 0 && (
            <>
              <Text size="xs" fw={700} c="grape.7" mt="md">
                {t('직접 연결 · 백링크 {count}', { count: backlinks.length })}
              </Text>
              <Stack gap="xs" mt="xs">
                {backlinks.map((item) => (
                  <button
                    key={item.edge.id}
                    className="related-row"
                    onClick={() => flow.fitView({ nodes: [{ id: item.note.id }], duration: 500, padding: 0.8 })}
                  >
                    <Text lineClamp={2} ta="left">
                      {item.note.title || item.note.content}
                    </Text>
                    <Text size="xs" c="dimmed" ta="left">
                      {item.direction === 'incoming' ? t('이 생각을 가리킴') : t('이 생각이 가리킴')} ·{' '}
                      {relationLabel(item.edge.relation)}
                      {item.edge.origin && item.edge.origin !== 'manual' && ` · ${originLabel(item.edge.origin)}`}
                    </Text>
                  </button>
                ))}
              </Stack>
            </>
          )}
          <Text size="xs" fw={700} c="blue.7" mt="md">
            {t('의미가 가까운 생각 {count}', { count: related.items.length })}
          </Text>
          <Stack gap="xs" mt="xs">
            {related.items.map((item) => (
              <button
                key={item.note.id}
                className="related-row"
                onClick={() => flow.fitView({ nodes: [{ id: item.note.id }], duration: 500, padding: 0.8 })}
              >
                <Text lineClamp={2} ta="left">
                  {item.note.content}
                </Text>
                <Text size="xs" c="dimmed" ta="left">
                  {item.reason} · {Math.round(item.score * 100)}%
                </Text>
              </button>
            ))}
          </Stack>
        </Paper>
      )}
      <Modal
        opened={suggestOpen}
        onClose={() => setSuggestOpen(false)}
        title={t('umm이 찾은 연결 {count}개', { count: suggestions.length })}
        centered
        size="lg"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t(
              '아래 연결은 umm이 추측한 것이라 캔버스에도 추천으로 표시됩니다. 남기면 직접 그은 연결이 되고, 지우면 사라집니다.',
            )}
          </Text>
          {suggestions.length === 0 && <Text size="sm">{t('모두 검토했습니다.')}</Text>}
          {suggestions.map((edge) => {
            const source = notes.find((note) => note.id === edge.source);
            const target = notes.find((note) => note.id === edge.target);
            return (
              <Paper key={edge.id} p="md" radius="md" withBorder>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" lineClamp={2}>
                      {source?.title || source?.content}
                    </Text>
                    <Text size="xs" c="dimmed">
                      ↕ {t('두드러진 정도')} {Math.round((edge.confidence ?? 0) * 100)}%
                    </Text>
                    <Text size="sm" lineClamp={2}>
                      {target?.title || target?.content}
                    </Text>
                  </Stack>
                  <Group gap="xs" wrap="nowrap">
                    <Button size="xs" variant="light" onClick={() => void answerSuggestion(edge.id, true)}>
                      {t('남기기')}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => void answerSuggestion(edge.id, false)}
                    >
                      {t('추천 지우기')}
                    </Button>
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      </Modal>
      <Modal
        opened={!!aiResult}
        onClose={() => setAIResult(undefined)}
        title={t('생각이 한 단계 자랐습니다')}
        centered
        size="lg"
      >
        <Stack>
          <Paper p="lg" radius="lg" bg="grape.0">
            <Text lh={1.75} style={{ whiteSpace: 'pre-wrap' }}>
              {aiResult?.content}
            </Text>
          </Paper>
          <Group justify="flex-end">
            <Button variant="light" onClick={() => setAIResult(undefined)}>
              {t('그대로 두기')}
            </Button>
            <Button
              onClick={() => {
                const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
                void createAt(aiResult?.content || '', center.x - 120, center.y - 80);
                setAIResult(undefined);
              }}
            >
              {t('새 생각으로 붙이기')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={!!commentNote}
        onClose={() => {
          setCommentNote(undefined);
          setComments([]);
        }}
        title={t('생각에 대한 대화')}
        centered
        size="lg"
      >
        <Stack>
          <Paper p="md" radius="md" bg="gray.0">
            <Text size="xs" c="dimmed">
              {t('대화 중인 생각')}
            </Text>
            <Text fw={650} lineClamp={3} mt={4}>
              {commentNote?.title || commentNote?.content || t('내용 없는 생각')}
            </Text>
          </Paper>
          <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap="sm">
              {comments.length === 0 ? (
                <Text c="dimmed" ta="center" py="xl">
                  {t('첫 댓글을 남겨 생각을 함께 발전시켜 보세요.')}
                </Text>
              ) : (
                comments.map((comment) => (
                  <Paper key={comment.id} withBorder p="md" radius="md" opacity={comment.resolvedAt?.length ? 0.58 : 1}>
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Group gap="xs">
                          <Text size="sm" fw={700}>
                            {comment.author}
                          </Text>
                          <Text size="xs" c="dimmed">
                            @{comment.username} · {formatDate(comment.createdAt)}
                          </Text>
                          {comment.resolvedAt && (
                            <Badge color="green" variant="light">
                              {t('해결됨')}
                            </Badge>
                          )}
                        </Group>
                        <Text size="sm" mt="xs" style={{ whiteSpace: 'pre-wrap' }}>
                          {comment.body}
                        </Text>
                      </div>
                      <Menu shadow="sm">
                        <Menu.Target>
                          <ActionIcon variant="subtle" aria-label={t('댓글 메뉴')}>
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item leftSection={<IconCheck size={14} />} onClick={() => void resolveComment(comment)}>
                            {comment.resolvedAt ? t('다시 열기') : t('해결 표시')}
                          </Menu.Item>
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => void deleteComment(comment)}
                          >
                            {t('삭제')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Paper>
                ))
              )}
            </Stack>
          </ScrollArea.Autosize>
          <Textarea
            label={t('댓글')}
            description={t('@username으로 공유 공간의 사용자를 언급할 수 있습니다. 네트워크가 끊기면 자동 보관됩니다.')}
            value={commentBody}
            onChange={(event) => setCommentBody(event.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={8}
            maxLength={4000}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void postComment();
              }
            }}
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t('Ctrl/⌘ + Enter로 게시')} · {commentBody.length}/4000
            </Text>
            <Button
              loading={commentBusy}
              disabled={!commentBody.trim()}
              leftSection={<IconMessageCircle size={16} />}
              onClick={() => void postComment()}
            >
              {t('댓글 남기기')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={!!conflict}
        onClose={() => setConflict(undefined)}
        title={t('메모 변경이 겹쳤습니다')}
        centered
        size="xl"
        closeOnClickOutside={false}
      >
        <Stack>
          <Alert color="yellow" icon={<IconGitMerge size={18} />}>
            {t(
              '다른 화면 또는 오프라인 재시도에서 같은 메모가 먼저 저장되었습니다. 내용을 비교한 뒤 안전하게 선택하세요.',
            )}
          </Alert>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" fw={700} c="blue.7">
                {t('내 변경')} · v{conflict?.local.version}
              </Text>
              <Text size="sm" mt="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {conflict?.local.content}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" fw={700} c="grape.7">
                {t('서버의 최신 내용')} · v{conflict?.latest.version}
              </Text>
              <Text size="sm" mt="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {conflict?.latest.content}
              </Text>
            </Paper>
          </SimpleGrid>
          <Textarea
            label={t('병합할 내용')}
            value={mergeDraft}
            onChange={(event) => setMergeDraft(event.currentTarget.value)}
            autosize
            minRows={5}
            maxRows={12}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => void applyConflict('server')}>
              {t('서버 내용 사용')}
            </Button>
            <Button variant="light" onClick={() => void applyConflict('local')}>
              {t('내 변경으로 덮기')}
            </Button>
            <Button leftSection={<IconGitMerge size={16} />} onClick={() => void applyConflict('merge')}>
              {t('편집한 내용으로 병합')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={spaceManagerOpen}
        onClose={() => {
          setSpaceManagerOpen(false);
          setSpaceQuery('');
          setSpaceError('');
        }}
        title={t('공간 관리')}
        centered
        size="lg"
      >
        <Stack>
          <Text c="dimmed" size="sm">
            {t('공간을 검색하고 이동하거나, 소유한 공간의 이름을 바꾸고 삭제할 수 있습니다.')}
          </Text>
          {spaceError && (
            <Alert color="red" withCloseButton onClose={() => setSpaceError('')}>
              {spaceError}
            </Alert>
          )}
          <Group align="flex-end">
            <TextInput
              label={t('새 공간')}
              placeholder={t('공간 이름')}
              value={newSpaceName}
              maxLength={200}
              onChange={(event) => setNewSpaceName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addSpace();
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              leftSection={<IconPlus size={16} />}
              loading={spaceBusy === 'new'}
              disabled={!newSpaceName.trim()}
              onClick={() => void addSpace()}
            >
              {t('만들기')}
            </Button>
          </Group>
          <Divider />
          <TextInput
            value={spaceQuery}
            onChange={(event) => setSpaceQuery(event.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            placeholder={t('공간 {count}개 중 검색', { count: spaces.length })}
          />
          <ScrollArea.Autosize mah={420} type="auto">
            <Stack gap="sm">
              {visibleSpaces.map((space) => {
                const owned = space.ownerId === user?.id;
                const changed = (spaceDrafts[space.id] || '').trim() !== space.name;
                return (
                  <Paper key={space.id} className="space-manager-row" p="sm" radius="md" withBorder>
                    <Group wrap="nowrap" align="flex-end">
                      <TextInput
                        label={owned ? t('내 공간') : t('공유 공간')}
                        value={spaceDrafts[space.id] ?? space.name}
                        disabled={!owned}
                        maxLength={200}
                        onChange={(event) =>
                          setSpaceDrafts((all) => ({ ...all, [space.id]: event.currentTarget.value }))
                        }
                        style={{ flex: 1 }}
                      />
                      <Group gap={5} wrap="nowrap">
                        <Tooltip label={t('이동')}>
                          <ActionIcon
                            variant={space.id === activeSpace ? 'filled' : 'light'}
                            color="grape"
                            aria-label={t('{name}으로 이동', { name: space.name })}
                            onClick={() => {
                              openSpace(space.id);
                              setSpaceManagerOpen(false);
                            }}
                          >
                            <IconArrowRight size={17} />
                          </ActionIcon>
                        </Tooltip>
                        {owned && (
                          <Tooltip label={t('이름 저장')}>
                            <ActionIcon
                              variant="light"
                              color="blue"
                              loading={spaceBusy === space.id}
                              disabled={!changed || !(spaceDrafts[space.id] || '').trim()}
                              aria-label={t('{name} 이름 저장', { name: space.name })}
                              onClick={() => void renameSpace(space)}
                            >
                              <IconEdit size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        {owned && (
                          <Tooltip label={t('공간 삭제')}>
                            <ActionIcon
                              variant="light"
                              color="red"
                              aria-label={t('{name} 삭제', { name: space.name })}
                              onClick={() => {
                                setDeleteCandidate(space);
                                setDeleteConfirmation('');
                              }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Group>
                    <Group justify="space-between" mt="xs">
                      <Group gap="xs">
                        {space.id === activeSpace && (
                          <Badge size="xs" variant="light">
                            {t('현재 공간')}
                          </Badge>
                        )}
                        {space.aiExcluded && (
                          <Badge size="xs" color="gray" variant="light">
                            {t('AI 제외')}
                          </Badge>
                        )}
                      </Group>
                      {owned && (
                        <Switch
                          size="xs"
                          label={t('AI Dream 분석')}
                          checked={!space.aiExcluded}
                          disabled={spaceBusy === `ai:${space.id}`}
                          onChange={(event) => void toggleSpaceAI(space, !event.currentTarget.checked)}
                        />
                      )}
                    </Group>
                  </Paper>
                );
              })}
              {visibleSpaces.length === 0 && (
                <Text c="dimmed" ta="center" py="xl">
                  {t('일치하는 공간이 없습니다.')}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      </Modal>
      <Modal
        opened={!!deleteCandidate}
        onClose={() => {
          if (!spaceBusy.startsWith('delete:')) {
            setDeleteCandidate(undefined);
            setDeleteConfirmation('');
          }
        }}
        title={t('공간을 삭제할까요?')}
        centered
        size="md"
        closeOnClickOutside={!spaceBusy.startsWith('delete:')}
      >
        <Stack>
          <Alert color="red" icon={<IconTrash size={18} />}>
            {t('공간 안의 메모, 연결, Dream 기록과 공유 정보가 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다.')}
          </Alert>
          {spaceError && <Alert color="red">{spaceError}</Alert>}
          <Text size="sm">
            {t('확인을 위해')}
            <b>{deleteCandidate?.name}</b>
            {t('을 입력하세요.')}
          </Text>
          <TextInput
            autoFocus
            value={deleteConfirmation}
            onChange={(event) => setDeleteConfirmation(event.currentTarget.value)}
            placeholder={deleteCandidate?.name}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setDeleteCandidate(undefined);
                setDeleteConfirmation('');
                setSpaceError('');
              }}
            >
              {t('취소')}
            </Button>
            <Button
              color="red"
              loading={spaceBusy === `delete:${deleteCandidate?.id}`}
              disabled={!deleteCandidate || deleteConfirmation !== deleteCandidate.name}
              onClick={() => void deleteSpace()}
            >
              {t('영구 삭제')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ImportThoughtsModal opened={importOpen} onClose={() => setImportOpen(false)} onImport={importThoughts} />
      <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title={t('이 공간 함께 쓰기')} centered size="lg">
        <Stack>
          {shareMessage && (
            <Paper p="sm" bg="grape.0">
              <Text size="sm">{shareMessage}</Text>
            </Paper>
          )}
          {canManage && (
            <Group align="flex-end">
              <TextInput
                label={t('사용자 아이디')}
                placeholder="username"
                value={shareUser}
                onChange={(e) => setShareUser(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Select
                label={t('권한')}
                value={sharePermission}
                onChange={(v) => v && setSharePermission(v)}
                data={[
                  { value: 'view', label: t('보기') },
                  { value: 'edit', label: t('편집') },
                  { value: 'manage', label: t('관리') },
                ]}
                w={120}
              />
              <Button disabled={!shareUser.trim()} onClick={() => void share()}>
                {t('초대')}
              </Button>
            </Group>
          )}
          <Stack gap="xs">
            {members.map((member) => (
              <Paper key={member.id} p="sm" bg="gray.0">
                <Group justify="space-between">
                  <div>
                    <Text fw={600}>{member.displayName}</Text>
                    <Text size="xs" c="dimmed">
                      {member.username} · {member.permission}
                    </Text>
                  </div>
                  {canManage && member.permission !== 'owner' && (
                    <ActionIcon color="red" variant="subtle" onClick={() => void removeMember(member.id)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Group>
              </Paper>
            ))}
          </Stack>
        </Stack>
      </Modal>
    </div>
  );
}

export default function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
