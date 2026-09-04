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
  IconArrowsMaximize,
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
  IconHistory,
  IconListDetails,
  IconPhoto,
  IconPlus,
  IconFocus2,
  IconPresentation,
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
  replayOfflineConflicts,
  type Attachment,
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
import PresentationModal from '../components/PresentationModal';
import { opensSummarised } from '../opening-view';
import BranchPanel from '../components/BranchPanel';
import { neighbourhood } from '../lens';
import { hasOverlaps, packGroups, ringAround, spreadOverlaps, type Placement } from '../layout';
import type { Branch } from '../components/BranchPanel';
import { readLocalStorage, readSessionStorage, writeLocalStorage, writeSessionStorage } from '../lib/browser-storage';
import {
  importLayout,
  type ImportedThought,
  type ImportedDocument,
  type ImportThoughtsResult,
} from '../lib/markdown-import';
import BacklinkRow from '../components/BacklinkRow';
import { relationLabel, relationOptions } from '../lib/edge-vocabulary';
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
// The canvas's own view limits, named once. The prediction in opening-view.ts
// has to use exactly these or it would predict a different opening view from
// the one fitView produces, and the canvas would flicker through the notes on
// its way to the summary.
const canvasView = { padding: 0.3, minZoom: 0.15, maxZoom: 2.2 };

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
/**
 * One undoable change of position, however many notes it touched.
 *
 * This used to hold a single note, and only dragging ever recorded one — so
 * arranging, which moves everything at once, could not be undone at all. On a
 * canvas where position is what a thought is remembered by, that made every
 * arrangement a decision you could not take back.
 */
interface HistoryAction {
  moves: { id: string; before: { x: number; y: number }; after: { x: number; y: number } }[];
}
interface RelatedThought {
  note: ThoughtNote;
  score: number;
  reason: string;
}
/** The canvas showing an instant that has passed. */
interface Rewind {
  /** RFC3339, the moment being looked at. */
  at: string;
  /**
   * Connections deleted between that moment and now. They were on the canvas
   * then and cannot be drawn: a deletion records that an edge went, never what
   * it joined. Shown rather than quietly missing.
   */
  removedEdges: number;
  /**
   * Pictures that were on the canvas then and cannot be drawn, because the
   * thought they hung on has been deleted since. That thought comes back, so
   * without saying this it comes back looking as though it never had one.
   */
  removedAttachments: number;
  /** The first moment this space has anything to show. */
  earliest: string;
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

/**
 * Pictures keyed by the thought they hang on.
 *
 * Shared by the two lists that can arrive — today's, and a rewound canvas's —
 * so a snapshot's pictures reach the notes through the same shape today's do.
 */
const groupByNote = (attachments: Attachment[]): Record<string, Attachment[]> => {
  const grouped: Record<string, Attachment[]> = {};
  for (const attachment of attachments) {
    (grouped[attachment.noteId] ??= []).push(attachment);
  }
  return grouped;
};

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
  /**
   * Whether this space may be written to.
   *
   * The server sends what the person asking may do with each space, because a
   * screen cannot work it out: the owner is obvious, but a member who may edit
   * and one who may only read look the same from here. Unknown is treated as
   * writable, so a space whose permission has not arrived behaves as it always
   * did rather than locking someone out of their own canvas.
   */
  /**
   * The moment being looked at, when the canvas is showing the past.
   *
   * Undefined means now, which is the ordinary state. Anything else means the
   * notes and connections on screen were reconstructed from what was recorded,
   * and nothing on this canvas may be changed.
   */
  /** The pictures on this space's thoughts, keyed by thought. */
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const pictureInput = useRef<HTMLInputElement>(null);
  const attachingTo = useRef<string>('');
  const [rewind, setRewind] = useState<Rewind>();
  // Read inside the event stream's handler, which is registered once per space
  // and would otherwise close over the value rewind had when it was registered.
  const rewindRef = useRef<Rewind | undefined>(undefined);
  useEffect(() => {
    rewindRef.current = rewind;
  }, [rewind]);
  const readOnly = useMemo(() => {
    const space = spaces.find((s) => s.id === activeSpace);
    // Rewinding belongs in the same test as the permission, not beside it.
    // Every place that asks "may this person change things" — dragging,
    // deleting, the note menu, the connection panel, the keyboard shortcuts —
    // reads this one value, and a second flag threaded past them would be one
    // path away from letting somebody edit a canvas that no longer exists.
    return space?.permission === 'view' || rewind !== undefined;
  }, [spaces, activeSpace, rewind]);
  /**
   * Whether this person may act on other people's comments here.
   *
   * The owner is sent as 'manage' too, so this is the one test for both. Used
   * to decide what the comment menu offers: resolving a discussion needs edit
   * or better, and deleting someone else's needs manage — offering either to
   * someone who will be refused is a button that exists to fail.
   */
  const managesSpace = useMemo(() => {
    const space = spaces.find((s) => s.id === activeSpace);
    return space?.permission === 'manage';
  }, [spaces, activeSpace]);
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
  // Whether the canvas has reported a real viewport yet. Until it has, how far
  // out the notes sit is a prediction; after it has, it is a fact, and the
  // prediction must get out of the way — otherwise zooming back in would never
  // bring the notes back, because the notes have not moved.
  const [viewportKnown, setViewportKnown] = useState(false);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  // The space whose grouping has been settled — arrived or failed. Recorded as
  // an id rather than a boolean flag so that "we have not asked yet" cannot
  // depend on which effect React happens to run first: the effect that builds
  // the nodes runs before the one that fetches, and a flag started at false
  // sent it down the "draw every note" path every time.
  const [clustersSettledFor, setClustersSettledFor] = useState('');
  // The canvas's own size, which decides how far out the notes have to be
  // fitted. Measured rather than assumed: the sidebar and the window both
  // change it.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
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
  // Read by the conflict listener below, which is registered once per space and
  // would otherwise see whatever `conflict` was when it was registered.
  const decidingRef = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [presentationOpen, setPresentationOpen] = useState(false);
  // Captured when the modal opens rather than read from it, so the deck matches
  // what was selected at the moment the person asked, not whatever the canvas
  // drifted to while they were reading the preview.
  const [presentationSelection, setPresentationSelection] = useState<string[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
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
    if (params.spaceId && params.spaceId !== activeSpace) {
      setActiveSpace(params.spaceId);
      // A different space opens fresh, so its opening view is predicted again
      // rather than inherited from wherever the last one had been zoomed to.
      setViewportKnown(false);
    }
  }, [params.spaceId]);
  const loadCanvas = useCallback(
    async (silent = false) => {
      if (!activeSpace) return;
      if (!silent) setLoading(true);
      try {
        const v = await api<{ notes: ThoughtNote[]; edges: ThoughtEdge[] }>(`/spaces/${activeSpace}/notes`);
        syncNotes(v.notes, true);
        setRawEdges(v.edges);
        setLoadFailed(false);
      } catch (reason) {
        /*
         * A space that could not be loaded is not an empty space.
         *
         * There was no catch here, so a failed load left the canvas with no
         * notes and it showed the hint it shows a new person: double-click
         * anywhere to start. Someone with a thousand thoughts was told to begin
         * — with an error notification above it that is easy to miss and much
         * smaller than the invitation underneath.
         */
        setLoadFailed(true);
        throw reason;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activeSpace],
  );
  const loadAttachments = useCallback(async () => {
    if (!activeSpace) return;
    try {
      const body = await api<{ attachments: Attachment[] }>(`/spaces/${activeSpace}/attachments`, { silent: true });
      setAttachments(groupByNote(body.attachments ?? []));
    } catch {
      // A canvas whose pictures could not be listed still shows its thoughts.
      setAttachments({});
    }
  }, [activeSpace]);

  /**
   * Show the space as it was, or return to now.
   *
   * The snapshot replaces what is on the canvas rather than sitting beside it,
   * so what a person sees is one canvas at one moment. Returning to now
   * reloads, rather than restoring a copy, because the space may have moved on
   * while they were looking backwards.
   */
  const rewindTo = useCallback(
    async (at: string | undefined) => {
      if (!activeSpace) return;
      if (!at) {
        setRewind(undefined);
        await loadCanvas();
        // The pictures came from the snapshot while it was showing, so today's
        // have to be fetched again — otherwise returning to now leaves the
        // canvas holding June's.
        await loadAttachments();
        return;
      }
      setLoading(true);
      try {
        const snapshot = await api<{
          at: string;
          notes: ThoughtNote[];
          edges: ThoughtEdge[];
          removedEdges: number;
          attachments: Attachment[];
          removedAttachments: number;
          earliest: string;
        }>(`/spaces/${activeSpace}/rewind?at=${encodeURIComponent(at)}`);
        syncNotes(snapshot.notes, true);
        setRawEdges(snapshot.edges);
        // The snapshot's pictures, not the canvas's. A photograph pasted this
        // morning on a thought as it stood in June would be the one thing on
        // that canvas nobody could date by reading it.
        setAttachments(groupByNote(snapshot.attachments ?? []));
        setRelated(undefined);
        setBacklinks([]);
        setRewind({
          at: snapshot.at,
          removedEdges: snapshot.removedEdges,
          removedAttachments: snapshot.removedAttachments ?? 0,
          earliest: snapshot.earliest,
        });
      } catch {
        // Already reported by the API layer. Staying where they were beats
        // showing a canvas that is neither then nor now.
      } finally {
        setLoading(false);
      }
    },
    [activeSpace, loadAttachments, loadCanvas, syncNotes],
  );

  /**
   * Put a picture on a thought.
   *
   * The file picker is a single hidden input reused for every thought rather
   * than one per card: a canvas with two thousand notes would otherwise carry
   * two thousand of them.
   */
  const attachPicture = useCallback((noteID: string) => {
    attachingTo.current = noteID;
    if (pictureInput.current) {
      pictureInput.current.value = '';
      pictureInput.current.click();
    }
  }, []);

  const uploadPicture = useCallback(
    async (file: File) => {
      const noteID = attachingTo.current;
      if (!noteID) return;
      const form = new FormData();
      form.append('file', file);
      try {
        await api<Attachment>(`/notes/${noteID}/attachments`, { method: 'POST', body: form });
        await loadAttachments();
      } catch {
        // The API layer has already said which rule was met and what the limit
        // is, which is the part a person can act on.
      }
    },
    [loadAttachments],
  );

  const removePicture = useCallback(
    async (attachmentID: string) => {
      try {
        await api(`/attachments/${attachmentID}`, { method: 'DELETE' });
        await loadAttachments();
      } catch {
        // Reported already.
      }
    },
    [loadAttachments],
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
    void loadAttachments();
    api<{ dreams: DreamHistory[] }>('/dreams', { silent: true })
      .then(({ dreams }) => {
        const fresh = dreams.find((d) => d.spaceId === activeSpace && d.status === 'created');
        if (fresh && !readSessionStorage(`dream:${fresh.dreamId}`).value) setMorningDream(fresh);
      })
      .catch(() => undefined);
  }, [activeSpace, loadCanvas, loadBranches, loadAttachments]);
  useEffect(() => {
    if (!activeSpace) return;
    const stream = new EventSource(`/api/v1/spaces/${activeSpace}/events`);
    stream.addEventListener('space-change', (event) => {
      // Somebody else's change must not redraw a canvas that is showing the
      // past. The person looking backwards would watch it silently become
      // today without being told.
      if (rewindRef.current) return;
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

  /**
   * Moves a set of notes and records the whole move as one undoable step.
   *
   * Every arrangement goes through here. Arranging without this recorded nothing,
   * so a person who did not like the result had no way back to the layout they
   * had built — and on this canvas that layout is the memory.
   */
  const applyPlacements = useCallback(
    (placements: Placement[]) => {
      /*
       * Arranging is a write, and every arrangement goes through here.
       *
       * The buttons that start one are hidden in a space this person may only
       * read, but this is the guard that holds: the next arrangement someone
       * adds gets it without having to remember. Without it a reader saw the
       * notes move, was told how many had been moved, and then watched every
       * save be refused — a success message for something that did not happen.
       */
      if (readOnly) return 0;
      const current = notesRef.current;
      const moves = placements
        .map((placement) => {
          const note = current[placement.id];
          if (!note) return undefined;
          const before = { x: note.x, y: note.y };
          const after = { x: placement.x, y: placement.y };
          if (before.x === after.x && before.y === after.y) return undefined;
          return { id: placement.id, before, after };
        })
        .filter((move): move is NonNullable<typeof move> => !!move);
      if (moves.length === 0) return 0;

      undo.current.push({ moves });
      redo.current = [];
      moves.forEach((move) => persist(move.id, move.after));
      const byID = new Map(moves.map((move) => [move.id, move.after]));
      setNodes((all) => all.map((n) => (byID.has(n.id) ? { ...n, position: byID.get(n.id)! } : n)));
      return moves.length;
    },
    [persist, setNodes, readOnly],
  );

  const gravity = useCallback(
    (selectedID?: string) => {
      const selected = selectedID ? flow.getNode(selectedID) : flow.getNodes().find((n) => n.selected);
      if (!selected) return;
      const related = new Set<string>();
      rawEdges.forEach((e) => {
        if (e.source === selected.id) related.add(e.target);
        if (e.target === selected.id) related.add(e.source);
      });
      const current = notesRef.current;
      const centre = current[selected.id];
      const around = [...related].map((id) => current[id]).filter(Boolean);
      if (!centre || around.length === 0) return;
      applyPlacements(ringAround(centre, around));
    },
    [flow, rawEdges, applyPlacements],
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
      // Seeing what a thought is related to is reading; pulling those thoughts
      // around it is not. A reader keeps the first half.
      const source = readOnly ? undefined : flow.getNode(id);
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
    [flow, persist, openNotePanel, readOnly],
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
      // One decision at a time. A second conflict — or the same one asked
      // again — would replace the comparison on screen and the text being
      // typed into it; it stays held in the queue and is asked again after
      // this one is answered.
      if (decidingRef.current) return;
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

  /*
   * Ask again about a conflict nobody was there to hear.
   *
   * `umm:offline-conflict` is raised once, and this is the only screen that
   * answers it — while a flush runs from the banner, on any page, for any
   * space. Raised with the canvas closed or another space open, the decision
   * reached no one, and the change would sit in the queue for good: skipped by
   * every flush, and reported as waiting for a connection that is already
   * there. Opening a space is the moment its held conflicts can be shown.
   *
   * Keyed on the space alone, so dismissing the dialog leaves it dismissed. The
   * banner's own button is how a reader comes back to it.
   */
  useEffect(() => {
    if (activeSpace) replayOfflineConflicts();
  }, [activeSpace]);

  useEffect(() => {
    decidingRef.current = !!conflict;
  }, [conflict]);

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

  /*
   * Whether the canvas is showing groups rather than thoughts.
   *
   * Worked out from where the notes are, not from mounting them and measuring.
   * fitView only reports the zoom after React Flow has built and measured every
   * node, so a space of two thousand notes built two thousand post-its and
   * threw them away for a handful of cluster boxes. Measured in a browser:
   * 2000 nodes mounted at +5.5s, replaced by 1 at +8.6s, against a request the
   * server answered in 85ms.
   *
   * zoomedOut stays part of it because a person can zoom out by hand, and then
   * the mounted view is the truth. The prediction only decides how the canvas
   * opens.
   */
  const summarised = useMemo(
    () =>
      viewportKnown
        ? zoomedOut
        : opensSummarised(
            searchMatches,
            { width: canvasSize.width, height: canvasSize.height },
            { ...canvasView, clusterZoom, clusterMinNotes },
          ),
    [viewportKnown, zoomedOut, searchMatches, canvasSize.width, canvasSize.height],
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
    /**
     * Carries React Flow's own measurements onto rebuilt nodes.
     *
     * These nodes are rebuilt from scratch whenever anything about a note
     * changes. A rebuilt node has no measurements, so React Flow hides it —
     * literally `visibility: hidden` — until it has measured it again, and
     * hiding an element blurs whatever inside it had the cursor.
     *
     * That is not theoretical. Naming a note and pressing Enter is supposed to
     * put the cursor in the thought; the save that follows rebuilt the node,
     * React Flow hid it, and the cursor was gone. Recorded from the page:
     *
     *   focusin  textarea[생각 내용]      the cursor arrives
     *   ATTR     visibility: hidden       the rebuild is measured
     *   focusout textarea -> null         and the cursor is dropped
     *
     * On a loaded machine it happened five times in six. The measurements have
     * not changed — the note is the same size it was a moment ago — so handing
     * them back is both what stops the flicker and what keeps the cursor.
     */
    const keepMeasured = <T extends { id: string; measured?: Node['measured'] }>(
      built: T[],
      current: readonly { id: string; measured?: Node['measured'] }[],
    ): T[] => {
      const measured = new Map(current.map((node) => [node.id, node.measured]));
      return built.map((node) => {
        const known = measured.get(node.id);
        return known ? { ...node, measured: known } : node;
      });
    };
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
          attachments: attachments[note.id],
          onAttach: attachPicture,
          onRemoveAttachment: removePicture,
          readOnly,
        },
      }));

    if (!summarised || searchMatches.length < clusterMinNotes) {
      setNodes((current) => keepMeasured(noteNodes(searchMatches), current));
      return;
    }

    // Summarised, but the groups have not arrived yet. Drawing every note here
    // would be building exactly what is about to be replaced — the cost this
    // whole path exists to avoid — so the canvas stays on its loading state,
    // which is true: it is still working out what to show.
    if (clusters.length === 0) {
      if (clustersSettledFor !== activeSpace) {
        setNodes([]);
        return;
      }
      // Asked, and there are no groups. The notes are what there is.
      setNodes((current) => keepMeasured(noteNodes(searchMatches), current));
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
    setNodes((current) =>
      keepMeasured([...clusterNodes, ...noteNodes(searchMatches.filter((note) => !grouped.has(note.id)))], current),
    );
  }, [
    searchMatches,
    persist,
    remove,
    restore,
    discoverRelated,
    openComments,
    zoomedOut,
    clusters,
    clustersSettledFor,
    activeSpace,
    summarised,
    lens,
    setAsideLines,
    // Whether the space can be written to arrives with the space list, which is
    // a separate request from the notes. Leaving it out meant the cards were
    // built once, while the answer was still unknown and every card therefore
    // editable, and never rebuilt when it landed: the canvas said "read-only"
    // in the notice and offered a working editor underneath it.
    readOnly,
    // Same shape: pictures arrive in their own request, and a card built before
    // they land would never show them.
    attachments,
    attachPicture,
    removePicture,
  ]);
  useEffect(() => {
    /*
     * A connection between two thoughts has nowhere to land when the canvas is
     * showing groups instead of thoughts.
     *
     * Building them anyway made React Flow resolve a handle for each one
     * against nodes that are not mounted: measured at 854ms of querySelector
     * and 250ms of getBBox in a space with two thousand connections, on a view
     * that draws none of them.
     */
    if (summarised) {
      setEdges([]);
      return;
    }
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
  }, [edgeStyle, rawEdges, searchMatches, lens, summarised, setEdges]);

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
    async (parsed: ImportedDocument, onProgress: (done: number) => void): Promise<ImportThoughtsResult> => {
      const { thoughts, connections, lines } = parsed;
      if (thoughts.length === 0) return { created: 0, failed: [] };
      if (!activeSpace) return { created: 0, failed: thoughts };
      const viewport = flow.screenToFlowPosition({ x: 140, y: 180 });
      const created: ThoughtNote[] = [];
      const failed: ImportedThought[] = [];
      // What each thought used to be called, so the connections between them can
      // be found again on the other side.
      const restored = new Map<string, string>();
      for (const [index, thought] of thoughts.entries()) {
        // A thought umm exported goes back where it was. On this canvas where a
        // thought sits is part of what it says, and a restored space laid out in
        // a fresh grid is a list of sentences, not the space someone built.
        const laidOut = importLayout(index, viewport.x, viewport.y);
        const position = thought.x === undefined || thought.y === undefined ? laidOut : { x: thought.x, y: thought.y };
        try {
          const note = await api<ThoughtNote>(`/spaces/${activeSpace}/notes`, {
            ...json('POST', {
              content: thought.content,
              title: thought.title,
              // A canvas people colour-code is a canvas where the colour is
              // part of what a thought says.
              color: thought.color ?? 'yellow',
              // A question that comes back a plain thought has lost the thing
              // that made it worth keeping apart.
              kind: thought.kind ?? 'thought',
              x: position.x,
              y: position.y,
              width: 240,
              height: 160,
              rotation: Math.round((Math.random() - 0.5) * 2),
            }),
            silent: true,
          });
          created.push(note);
          if (thought.sourceId) restored.set(thought.sourceId, note.id);
        } catch {
          // A single rejected note must not abandon the ones that follow.
          failed.push(thought);
        }
        onProgress(index + 1);
      }

      // The connections, rebuilt against the thoughts that actually arrived.
      //
      // A connection whose either end failed to import has nowhere to attach,
      // and is dropped rather than reported: the thought it belonged to is
      // already in the retry draft, and a connection to a thought that is not
      // there cannot be retried on its own.
      let connected = 0;
      for (const connection of connections) {
        const source = restored.get(connection.from);
        const target = restored.get(connection.to);
        if (!source || !target) continue;
        try {
          await api<ThoughtEdge>(`/spaces/${activeSpace}/edges`, {
            ...json('POST', { source, target, relation: connection.relation, reason: connection.reason ?? '' }),
            silent: true,
          });
          connected += 1;
        } catch {
          // A refused connection is not worth losing the import over.
        }
      }
      // The lines of thinking, and how each of them ended.
      //
      // A thought that was tried and set aside reads exactly like a current one
      // once the label is gone, and the reason it was set aside is the half
      // people lose first. Restoring the thoughts without them hands back the
      // decisions and drops every why.
      let revived = 0;
      for (const line of lines) {
        const members = thoughts
          .filter((thought) => thought.line === line.name && thought.sourceId)
          .map((thought) => restored.get(thought.sourceId as string))
          .filter((id): id is string => !!id);
        try {
          const branch = await api<Branch>(`/spaces/${activeSpace}/branches`, {
            ...json('POST', { name: line.name }),
            silent: true,
          });
          for (const noteID of members) {
            await api(`/notes/${noteID}/branch`, { ...json('PUT', { branchId: branch.id }), silent: true });
          }
          // Resolved last: a line is closed with the thoughts already in it, the
          // same order a person would do it in.
          if (line.status === 'adopted' || line.status === 'abandoned') {
            await api(`/branches/${branch.id}/resolve`, {
              ...json('POST', { status: line.status, resolution: line.resolution }),
              silent: true,
            });
          }
          revived += 1;
        } catch {
          // A line that cannot be rebuilt must not cost the thoughts already in.
        }
      }
      if (connected > 0 || revived > 0) {
        await loadCanvas(true);
        if (revived > 0) await loadBranches();
      }
      if (created.length > 0) {
        for (const note of created) durableNotesRef.current[note.id] = note;
        syncNotes([...Object.values(notesRef.current), ...created]);
        showSuccess(
          connected > 0 || revived > 0
            ? t('{count}개의 생각과 {links}개의 연결, {lines}개의 갈래를 되살렸습니다.', {
                count: created.length,
                links: connected,
                lines: revived,
              })
            : t('{count}개의 생각을 캔버스에 붙였습니다.', { count: created.length }),
          t('가져오기 완료'),
        );
      }
      return { created: created.length, failed };
    },
    [activeSpace, flow, t, loadCanvas, loadBranches],
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
      // Told apart from "nothing was close enough", which is what an unknown
      // outcome would otherwise be reported as — and which would be untrue.
      if (result.outcome === 'read-only') {
        showInfo(t('읽기 전용으로 공유된 공간이라 연결을 추가할 수 없습니다.'), t('추천을 건너뛰었습니다'));
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

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const box = element.getBoundingClientRect();
      setCanvasSize((current) =>
        Math.round(current.width) === Math.round(box.width) && Math.round(current.height) === Math.round(box.height)
          ? current
          : { width: box.width, height: box.height },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Clusters are fetched when the canvas crosses into the zoomed-out view and
  // then reused, because the grouping does not change as the person keeps
  // zooming and refetching on every wheel tick would be a request storm.
  useEffect(() => {
    // Asked for as soon as the canvas is going to open summarised, rather than
    // waiting for a zoom event that only arrives after every note has been
    // mounted and measured.
    if (!summarised || !activeSpace) return;
    let cancelled = false;
    const asked = activeSpace;
    api<{ clusters: Cluster[] }>(`/spaces/${asked}/clusters`, { silent: true })
      .then((result) => {
        if (!cancelled) setClusters(result.clusters);
      })
      .catch(() => {
        if (!cancelled) setClusters([]);
      })
      .finally(() => {
        if (!cancelled) setClustersSettledFor(asked);
      });
    return () => {
      cancelled = true;
    };
  }, [summarised, activeSpace]);

  // Cluster shapes are not draggable, so only post-its reach these — but the
  // handler types follow the node union the canvas is declared with.
  const onDragStart: OnNodeDrag<CanvasNode> = (_, node) => {
    dragStart.current[node.id] = { ...node.position };
  };
  const onDragStop: OnNodeDrag<CanvasNode> = (_, node) => {
    const before = dragStart.current[node.id];
    const after = { ...node.position };
    if (before && (before.x !== after.x || before.y !== after.y)) {
      undo.current.push({ moves: [{ id: node.id, before, after }] });
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
      if (!editing && !readOnly && (event.key === 'Delete' || event.key === 'Backspace')) {
        // Guarded here rather than at the confirmation, because the question
        // itself is the offer: asking someone whether to delete three thoughts
        // they are not allowed to delete is the same false promise as a button
        // that fails.
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
      if (!editing && !readOnly && mod && key === 'z') {
        // Undo replays positions through the same save. Nothing should be in
        // the stack for a reader now that arranging is refused, but a stack
        // that is empty by accident is not a guard.
        event.preventDefault();
        const action = event.shiftKey ? redo.current.pop() : undo.current.pop();
        if (!action) return;
        const positions = new Map(
          action.moves.map((move) => [move.id, event.shiftKey ? move.after : move.before] as const),
        );
        positions.forEach((position, id) => persist(id, position));
        setNodes((all) => all.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)));
        (event.shiftKey ? undo.current : redo.current).push(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // readOnly belongs here for the same reason it belongs in the effect that
    // builds the cards: the permission arrives after this binds, and a handler
    // holding the old answer keeps offering to delete in a space that has since
    // turned out to be read-only.
  }, [flow, persist, remove, setNodes, readOnly]);

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
    if (clusters.length === 0) {
      showInfo(t('아직 뚜렷한 생각 군집이 없습니다. 조금 더 생각을 붙여보세요.'), t('생각 군집'));
      return;
    }
    const current = notesRef.current;
    // Only the notes that belong to a group are moved. Laying out the whole
    // space would throw away where someone put everything else, and the notes
    // outside a group are the ones whose placement was most deliberate.
    const groups = clusters
      .map((cluster) => cluster.noteIds.map((id) => current[id]).filter(Boolean))
      .filter((group) => group.length > 0);
    const grouped = new Set(groups.flat().map((note) => note.id));
    const moved = applyPlacements(packGroups(groups));
    showInfo(
      t('생각 {count}개를 묶음별로 정렬했습니다. 묶이지 않은 {kept}개는 그대로 두었습니다. Ctrl+Z로 되돌립니다.', {
        count: moved,
        kept: Object.keys(current).length - grouped.size,
      }),
      t('생각 군집'),
    );
  };

  /**
   * Separates notes that sit on top of each other and leaves everything else be.
   *
   * The other two arrangements replace a layout; this one keeps it. A note with
   * room around it is not moved at all, so tidying a crowded corner does not cost
   * someone the placement they built everywhere else.
   */
  const spreadThoughts = () => {
    const current = notesRef.current;
    const chosen = flow
      .getNodes()
      .filter((n) => n.selected && n.type === 'postit')
      .map((n) => current[n.id])
      .filter(Boolean);
    const target = chosen.length > 1 ? chosen : Object.values(current);
    const scope = chosen.length > 1 ? t('선택한 생각') : t('이 공간');

    if (!hasOverlaps(target)) {
      showInfo(t('{scope}에서 겹친 생각이 없습니다.', { scope }), t('겹침 정리'));
      return;
    }
    const moved = applyPlacements(spreadOverlaps(target));
    showInfo(
      t('겹친 생각 {count}개만 옮겼습니다. 나머지는 그대로입니다. Ctrl+Z로 되돌립니다.', { count: moved }),
      t('겹침 정리'),
    );
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
  /**
   * The space as a document rather than as a backup.
   *
   * The Markdown export answers "give me everything back later" and carries
   * ids, coordinates and connections so a space can be restored from it. This
   * answers "I want to start writing this up", so it carries none of that —
   * the sentences in the order the graph puts them, and nothing to skip past.
   */
  const downloadOutline = async () => {
    if (!(await ensureExport('outline'))) return false;
    const response = await fetch(`/api/v1/spaces/${activeSpace}/export/outline`, { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || payload.error || t('문서 차례를 만들지 못했습니다.'));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `umm-${activeName}-${t('차례')}.md`;
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
    <div className="canvas-page" ref={canvasRef}>
      {loading && (
        <div className="canvas-loading" role="status" aria-label={t('생각 불러오는 중')}>
          <Loader color="grape" />
        </div>
      )}
      {listView ? (
        <ScrollArea className="canvas-linear-view" type="auto">
          <section aria-label={t('생각 선형 목록')}>
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
          </section>
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
            // The canvas has now said where it actually is, so the prediction
            // stands down.
            setViewportKnown(true);
            // Only the crossing matters, so state changes once per crossing
            // rather than on every wheel tick.
            const out = viewport.zoom < clusterZoom;
            setZoomedOut((current) => (current === out ? current : out));
          }}
          fitView
          fitViewOptions={{ padding: canvasView.padding }}
          minZoom={canvasView.minZoom}
          maxZoom={canvasView.maxZoom}
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
            {/* Suggesting connections writes them, so it is not offered in a
                space this person may only read. The server refuses it too — this
                is so the refusal never has to happen. */}
            {!readOnly && (
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
            )}
            <div className="canvas-tool-divider" aria-hidden="true" />
            {/* Looking backwards is reading, so it is offered whatever the
                permission — and it makes the canvas read-only while it lasts,
                whatever the permission was. */}
            <Menu position="bottom" withinPortal width={200}>
              <Menu.Target>
                <Tooltip label={t('되감기')}>
                  <ActionIcon
                    className="canvas-action"
                    variant={rewind ? 'filled' : 'subtle'}
                    color="dark"
                    aria-label={t('되감기')}
                    aria-pressed={!!rewind}
                  >
                    <IconHistory size={19} />
                  </ActionIcon>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown>
                {rewind && <Menu.Item onClick={() => void rewindTo(undefined)}>{t('지금으로')}</Menu.Item>}
                {(
                  [
                    { label: t('하루 전'), ago: 1 },
                    { label: t('일주일 전'), ago: 7 },
                    { label: t('한 달 전'), ago: 30 },
                    { label: t('석 달 전'), ago: 90 },
                  ] as const
                ).map((point) => (
                  <Menu.Item
                    key={point.ago}
                    onClick={() => void rewindTo(new Date(Date.now() - point.ago * 86400000).toISOString())}
                  >
                    {point.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <div className="canvas-tool-divider" aria-hidden="true" />
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
            <div className="canvas-tool-divider" aria-hidden="true" />
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
                  leftSection={<IconListDetails size={16} />}
                  onClick={() => void runExport('outline', t('문서 차례'), downloadOutline)}
                >
                  {t('문서 차례 (Markdown)')}
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
            <Tooltip label={t('이 공간을 발표 자료로')}>
              <ActionIcon
                className="canvas-action"
                variant="subtle"
                color="dark"
                aria-label={t('이 공간을 발표 자료로')}
                onClick={() => {
                  setPresentationSelection(
                    flow
                      .getNodes()
                      .filter((node) => node.selected)
                      .map((node) => node.id),
                  );
                  setPresentationOpen(true);
                }}
              >
                <IconPresentation size={18} />
              </ActionIcon>
            </Tooltip>
            <div className="canvas-tool-divider" aria-hidden="true" />
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
            <div className="canvas-tool-divider" aria-hidden="true" />
            {!readOnly && (
              <>
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
                <Tooltip label={t('겹친 생각만 펼치기')}>
                  <ActionIcon
                    className="canvas-action"
                    variant="subtle"
                    color="teal"
                    onClick={() => spreadThoughts()}
                    aria-label={t('겹침 정리')}
                  >
                    <IconArrowsMaximize size={20} />
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
              </>
            )}
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
              {!readOnly && (
                <>
                  <Menu.Item leftSection={<IconLayoutGrid size={17} />} onClick={() => void clusterThoughts()}>
                    {t('생각 군집 모으기')}
                  </Menu.Item>
                  <Menu.Item leftSection={<IconFocusCentered size={17} />} onClick={() => gravity()}>
                    {t('연결한 생각 모으기')}
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Paper>
      {!loading && loadFailed && (
        <div className="onboarding-hint">
          <div>
            <Text fz="lg" fw={650}>
              {t('이 공간을 불러오지 못했습니다.')}
            </Text>
            <Text c="dimmed" mt={4}>
              {t('생각이 사라진 것이 아니라 가져오지 못한 것입니다.')}
            </Text>
            <Button mt="md" variant="light" onClick={() => void loadCanvas()}>
              {t('다시 시도')}
            </Button>
          </div>
        </div>
      )}
      {!loading && !loadFailed && notes.length === 0 && (
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
      {/* A space you may only read says so once, here, rather than letting you
          find out by typing into it. The bar below is left in place and
          disabled: removing it would leave the canvas looking ordinary and the
          absence unexplained. */}
      {readOnly && (
        <Paper className="quick-capture" radius="xl" px="lg" py="xs">
          <Text size="sm" c="dimmed">
            {/* Why it is read-only, not just that it is. Rewinding makes this
                true for anybody, including the owner of the space, and telling
                them their own space is shared read-only would be a sentence
                about something that did not happen. */}
            {rewind
              ? t('지나간 시점을 보고 있어 바꿀 수 없습니다. 지금으로 돌아오면 다시 씁니다.')
              : t('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')}
          </Text>
        </Paper>
      )}
      {!readOnly && (
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
      )}
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
      {/* One picker for the whole canvas: a card each would put thousands of
          file inputs in the document on a large space. */}
      <input
        ref={pictureInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void uploadPicture(file);
        }}
      />
      {rewind && (
        <Paper className="lens-banner glass" radius="xl" p="xs" px="md">
          <Group gap="xs" wrap="nowrap">
            <IconHistory size={16} />
            <Text size="sm" fw={600}>
              {t('{when}의 공간입니다', { when: new Date(rewind.at).toLocaleString() })}
            </Text>
            <Text size="xs" c="dimmed">
              {/* Not "this is everything that was here". A connection removed
                  since cannot be drawn — the log records that one went, never
                  what it joined — so the number is said rather than left as a
                  gap the reader would take for absence. A picture whose thought
                  was deleted since is the same kind of gap: the thought comes
                  back, and it comes back looking as though it never had one. */}
              {rewind.removedEdges > 0 && rewind.removedAttachments > 0
                ? t('그 뒤 지워진 연결 {edges}개와 그림 {pictures}장은 되살릴 수 없어 빠져 있습니다.', {
                    edges: rewind.removedEdges,
                    pictures: rewind.removedAttachments,
                  })
                : rewind.removedEdges > 0
                  ? t('그 뒤 지워진 연결 {count}개는 되살릴 수 없어 빠져 있습니다.', { count: rewind.removedEdges })
                  : rewind.removedAttachments > 0
                    ? t('그 뒤 지워진 생각에 붙어 있던 그림 {count}장은 되살릴 수 없어 빠져 있습니다.', {
                        count: rewind.removedAttachments,
                      })
                    : t('바꿀 수는 없고 보기만 합니다.')}
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={() => void rewindTo(undefined)}>
              {t('지금으로')}
            </Button>
          </Group>
        </Paper>
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
              readOnly={readOnly}
            />
          )}
          {backlinks.length > 0 && (
            <>
              <Text size="xs" fw={700} c="grape.7" mt="md">
                {t('직접 연결 · 백링크 {count}', { count: backlinks.length })}
              </Text>
              <Stack gap="xs" mt="xs">
                {backlinks.map((item) => (
                  <BacklinkRow
                    key={item.edge.id}
                    edge={item.edge}
                    title={item.note.title || item.note.content}
                    direction={item.direction}
                    readOnly={readOnly}
                    onFocus={() => flow.fitView({ nodes: [{ id: item.note.id }], duration: 500, padding: 0.8 })}
                    onSaved={(saved) => {
                      setBacklinks((all) =>
                        all.map((row) => (row.edge.id === saved.id ? { ...row, edge: saved } : row)),
                      );
                      // The canvas holds its own copy of every edge, and a deck
                      // compiled from this space reads the reason off it.
                      setRawEdges((all) => all.map((edge) => (edge.id === saved.id ? saved : edge)));
                    }}
                  />
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
                      {(() => {
                        // Only what this person can actually do. Resolving a
                        // discussion needs edit or better; deleting one is for
                        // whoever wrote it, or for someone who manages the
                        // space. The menu used to offer both to everyone, so a
                        // member shared in to read was invited to resolve and
                        // delete and told no by the server afterwards.
                        const mine = comment.username === user?.username;
                        const mayResolve = !readOnly;
                        const mayDelete = mine || managesSpace;
                        if (!mayResolve && !mayDelete) return null;
                        return (
                          <Menu shadow="sm">
                            <Menu.Target>
                              <ActionIcon variant="subtle" aria-label={t('댓글 메뉴')}>
                                <IconDots size={16} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {mayResolve && (
                                <Menu.Item
                                  leftSection={<IconCheck size={14} />}
                                  onClick={() => void resolveComment(comment)}
                                >
                                  {comment.resolvedAt ? t('다시 열기') : t('해결 표시')}
                                </Menu.Item>
                              )}
                              {mayDelete && (
                                <Menu.Item
                                  color="red"
                                  leftSection={<IconTrash size={14} />}
                                  onClick={() => void deleteComment(comment)}
                                >
                                  {t('삭제')}
                                </Menu.Item>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        );
                      })()}
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
      <PresentationModal
        opened={presentationOpen}
        onClose={() => setPresentationOpen(false)}
        spaceID={activeSpace}
        spaceName={activeName}
        selection={presentationSelection}
      />
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
