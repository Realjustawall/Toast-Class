import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomConnection } from './live';
import { usePlatformOptions } from './platform-options';
import type { LockSettings } from './classroom-lock-dialog';
import ConnectionSignal from './connection-signal';
import BoardPdfImport from './board-pdf-import';
import ClassroomLockDialog from './classroom-lock-dialog';
import { useSharedWorkspace } from './shared-workspace';
import Chat from './chat';
import MediaModeration from './media-moderation';
import type { PresentationState } from './presentations';
const Presentations = lazy(() => import('./presentations'));
const Files = lazy(() => import('./files'));
const AdvancedBoard = lazy(() => import('./advanced-board'));
const GeoGebraWorkspace = lazy(() => import('./geogebra-workspace'));
const SandboxWorkspace = lazy(() => import('./sandbox-workspace'));
import Breakouts, { BreakoutStatus } from './breakouts';
import {
  DEFAULT_CLASSROOM_PERMISSIONS,
  STATUS_EMOJIS,
  type ClassroomPermissions,
  type ClassroomTheme,
  type ClassroomView,
  type MediaIntent,
  type ParticipantMediaState,
  type ParticipantStatusKind,
  type UserEffectivePermissions,
  type UserPermissionOverride,
} from './classroom-types';
const Media = lazy(() => import('./media'));
import CollaborativeDocument from './workspace-document';
import ClassroomLoading from './classroom-loading';
import ClassIcon from './classroom-icons';
import { useClassroomPanelLayout } from './classroom-panel-layout';
import { participantAvatarStyle } from './participant-identity';
import AudioJoinDialog, { type AudioPolicy } from './audio-join-dialog';
import { useClassroomSounds, playClassroomSound } from './classroom-sounds';
import { IndividualUserPermissionsManager } from './theme-preview';
import AnnotationPageManager from './annotation-page-manager';

type Poll = {
  id: string;
  question: string;
  options: string[];
  status: string;
  results_published: boolean;
  counts?: number[];
  responseCount: number;
  myChoice: number | null;
};
type ClassroomAppKey =
  'activities' | 'files' | 'geogebra' | 'sandbox' | 'breakouts' | 'attendance' | 'announcements';
const classroomAppTitles: Record<ClassroomAppKey, string> = {
  activities: 'activities',
  files: 'fileLibrary',
  geogebra: 'geoTitle',
  sandbox: 'sandboxTitle',
  breakouts: 'breakoutRooms',
  attendance: 'attendance',
  announcements: 'classroomAnnouncements',
};

type State = {
  selectedStudent?: { id: string; name: string } | null;
  locks?: LockSettings;
  session: { id: string; started_at?: string } | null;
  participants?: { id: string; name: string; role: string }[];
  role: string;
  userId: string;
  theme?: ClassroomTheme;
  permissions?: ClassroomPermissions;
  pinnedNotice?: string;
  externalMediaUrl?: string;
  myPermissions?: UserEffectivePermissions;
  userPermissions?: UserPermissionOverride[];
  statuses?: { user_id: string; status: ParticipantStatusKind }[];
  serverTime: number;
  hands: { user_id: string; name: string; raised_at: string }[];
  polls: Poll[];
  timer: { deadline: string | null; remaining_ms: number; status: string } | null;
};

type Document = {
  id: string;
  name: string;
  kind: 'notes' | 'board';
  teacher_only: boolean;
  board_format?: string;
  board_book_id?: string | null;
  page_archived?: boolean;
  page_bookmark?: string;
  page_rotation?: number;
  pdf_source_file_id?: string | null;
  pdf_source_page?: number | null;
  board_page_index?: number;
  background_file_id?: string | null;
  background_width?: number | null;
  background_height?: number | null;
};

export default function Teaching({
  room,
  onLeave,
  onNavigate,
}: {
  room: ClassroomView;
  onLeave: () => void;
  onNavigate: (room: ClassroomView) => void;
}) {
  const { t, i18n } = useTranslation();
  const { options, reload: reloadOptions } = usePlatformOptions();
  useClassroomConnection(room.id, () => void reloadOptions(), ['platform_changed']);
  const base = '/classrooms/' + room.id;
  const [media, setMedia] = useState<{ token: string; url: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [audioDialogOpen, setAudioDialogOpen] = useState(false);
  const [audioOffer, setAudioOffer] = useState<{
    token: string;
    url: string;
    policy: AudioPolicy;
  }>();
  const joinAbort = useRef<AbortController | null>(null),
    joinVersion = useRef(0);
  const cancelJoin = () => {
    setAudioDialogOpen(false);
    joinVersion.current++;
    joinAbort.current?.abort();
    setJoining(false);
    setBusy(false);
  };
  useEffect(
    () => () => {
      joinVersion.current++;
      joinAbort.current?.abort();
    },
    [],
  );
  const hadMedia = useRef(!!room.mediaResume);
  const intent = useRef<MediaIntent>(room.mediaResume ?? { microphone: false, camera: false });
  function move(next: ClassroomView) {
    onNavigate({ ...next, ...(hadMedia.current ? { mediaResume: intent.current } : {}) });
  }
  useEffect(() => {
    if (!room.mediaResume) return;
    let active = true;
    void request<{ token: string; url: string; policy: AudioPolicy }>(base + '/join', {})
      .then((join) => {
        if (active) {
          intent.current = {
            microphone: intent.current.microphone && join.policy.microphone,
            camera: intent.current.camera && join.policy.camera,
          };
          setMedia(join);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [room.id]);

  const [sidePanel, setSidePanel] = useState<'chat' | 'people' | 'apps' | null>(() =>
    window.matchMedia('(max-width:1099px)').matches || room.theme === 'immersive-glass'
      ? null
      : 'chat',
  );
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width:1099px)').matches);
  const [closedPanels, setClosedPanels] = useState<Set<'chat' | 'people'>>(new Set());
  const [appsPage, setAppsPage] = useState<ClassroomAppKey | null>(null);
  const appZoomKey = 'classroom-app-content-zoom-v1:' + room.id;
  const [appContentZoom, setAppContentZoom] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(appZoomKey));
      return Number.isFinite(saved) && saved >= 0.8 && saved <= 1.5 ? saved : 1;
    } catch {
      return 1;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(appZoomKey, String(appContentZoom));
    } catch {}
  }, [appZoomKey, appContentZoom]);
  const [peopleFilter, setPeopleFilter] = useState<'all' | 'hands' | 'speaking'>('all');
  const [peopleSearch, setPeopleSearch] = useState('');
  const [peoplePage, setPeoplePage] = useState(0);
  const [selectedParticipant, setSelectedParticipant] = useState<string>();
  const boardSync = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => setPeoplePage(0), [peopleSearch, peopleFilter]);
  const [lockPopoverOpen, setLockPopoverOpen] = useState(false);
  const [lockTarget, setLockTarget] = useState<{ id: string; name: string }>();

  const panelOpen = (panel: 'chat' | 'people') =>
    compact || (state?.theme ?? room.theme) === 'immersive-glass'
      ? sidePanel === panel
      : sidePanel === 'apps' && panel === 'people'
        ? false
        : !closedPanels.has(panel);

  function togglePanel(panel: 'chat' | 'people') {
    panelLayout.collapse();
    if (compact || (state?.theme ?? room.theme) === 'immersive-glass')
      setSidePanel((current) => (current === panel ? null : panel));
    else {
      if (panel === 'people' && sidePanel === 'apps') {
        setAppsPage(null);
        setClosedPanels((current) => {
          const next = new Set(current);
          next.delete('people');
          return next;
        });
        setSidePanel('people');
        return;
      }
      setClosedPanels((current) => {
        const next = new Set(current);
        if (next.has(panel)) next.delete(panel);
        else next.add(panel);
        return next;
      });
      setSidePanel(panel);
    }
  }
  function closePanel(panel: 'chat' | 'people') {
    panelLayout.collapse();
    setClosedPanels((current) => new Set([...current, panel]));
    setSidePanel((current) =>
      current === panel || (panel === 'people' && current === 'apps') ? null : current,
    );
    if (panel === 'people') setAppsPage(null);
  }
  function toggleAppsPanel() {
    panelLayout.collapse();
    setAppsPage(null);
    if (sidePanel !== 'apps') panelLayout.resize('people', 300);
    if (compact || (state?.theme ?? room.theme) === 'immersive-glass') {
      setSidePanel((current) => (current === 'apps' ? null : 'apps'));
      return;
    }
    setClosedPanels((current) => {
      const next = new Set(current);
      next.delete('people');
      return next;
    });
    setSidePanel((current) => (current === 'apps' ? 'people' : 'apps'));
  }
  useEffect(() => {
    const query = window.matchMedia('(max-width:1099px)');
    const collapse = () => {
      setCompact(query.matches);
      if (query.matches) setSidePanel(null);
    };
    query.addEventListener('change', collapse);
    return () => query.removeEventListener('change', collapse);
  }, []);

  const [manageDocuments, setManageDocuments] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [geogebraOpened, setGeogebraOpened] = useState(false);
  const [sandboxOpened, setSandboxOpened] = useState(false);
  const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(null),
    [screenSharing, setScreenSharing] = useState(false);
  const shell = useRef<HTMLDivElement>(null),
    documentDialog = useRef<HTMLDialogElement>(null),
    settingsDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (manageDocuments) documentDialog.current?.showModal();
    else documentDialog.current?.close();
  }, [manageDocuments]);

  useEffect(() => {
    if (settingsOpen) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settingsOpen]);

  const [state, setState] = useState<State>();
  const [speakers, setSpeakers] = useState<Set<string>>(new Set());
  const updateSpeakers = useCallback((ids: string[]) => setSpeakers(new Set(ids)), []);
  const [participantMedia, setParticipantMedia] = useState<Map<string, ParticipantMediaState>>(
    new Map(),
  );
  const updateParticipantMedia = useCallback((people: ParticipantMediaState[]) => {
    setParticipantMedia(new Map(people.map((person) => [person.id, person])));
  }, []);
  const { sounds, toggle: toggleSounds } = useClassroomSounds(
    state?.participants ?? [],
    state?.hands ?? [],
    state?.userId,
  );
  const [galleryTarget, setGalleryTarget] = useState<HTMLDivElement | null>(null);
  const [accessError, setAccessError] = useState('');
  const [draftNotice, setDraftNotice] = useState(room.pinnedNotice ?? '');
  const [draftExternalUrl, setDraftExternalUrl] = useState(room.externalMediaUrl ?? '');
  const [randomStudent, setRandomStudent] = useState<string | null>(null);
  useEffect(() => {
    setRandomStudent(state?.selectedStudent?.name ?? null);
  }, [state?.selectedStudent?.id, state?.selectedStudent?.name]);

  useEffect(() => {
    if (settingsOpen) return;
    if (state?.pinnedNotice !== undefined) setDraftNotice(state.pinnedNotice);
    if (state?.externalMediaUrl !== undefined) setDraftExternalUrl(state.externalMediaUrl);
  }, [settingsOpen, state?.pinnedNotice, state?.externalMediaUrl]);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const activitySounds = useRef<
    { session: string; polls: string; timer: string; notice: string; finished: boolean } | undefined
  >(undefined);
  useEffect(() => {
    if (!state) return;
    const timer = state.timer,
      finished =
        !!timer?.deadline &&
        timer.status === 'running' &&
        new Date(timer.deadline).getTime() <= clock + offset;
    const next = {
      session: state.session?.id ?? '',
      polls: JSON.stringify(state.polls.map((p) => [p.id, p.status, p.results_published])),
      timer: JSON.stringify([timer?.status, timer?.deadline]),
      notice: state.pinnedNotice ?? '',
      finished,
    };
    const old = activitySounds.current;
    if (old) {
      if (old.session !== next.session) playClassroomSound('session');
      if (old.polls !== next.polls) playClassroomSound('poll');
      if (old.timer !== next.timer || (!old.finished && finished)) playClassroomSound('timer');
      if (old.notice !== next.notice) playClassroomSound('notice');
    }
    activitySounds.current = next;
  }, [state?.session?.id, state?.polls, state?.timer, state?.pinnedNotice, clock, offset]);
  const oldAccessSound = useRef<{ signature: string; count: number } | undefined>(undefined);
  useEffect(() => {
    if (!state?.myPermissions) return;
    const flags = Object.entries(state.myPermissions).filter(
        ([key, value]) => key.startsWith('can') && typeof value === 'boolean',
      ),
      locks = Object.values(state.locks?.locks ?? {}),
      count = flags.filter(([, value]) => !value).length + locks.filter(Boolean).length,
      signature = JSON.stringify([flags, state.locks?.locks]);
    if (oldAccessSound.current && oldAccessSound.current.signature !== signature)
      playClassroomSound(count > oldAccessSound.current.count ? 'lock' : 'unlock');
    oldAccessSound.current = { signature, count };
  }, [state?.myPermissions, state?.locks]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [presentations, setPresentations] = useState<PresentationState>();
  const [docId, setDocId] = useState('');
  const [attendance, setAttendance] = useState<{
    participants: {
      userId: string;
      name: string;
      totalDurationMs: number;
      connections: { id: string; joined_at: string | null; left_at: string | null }[];
    }[];
  } | null>(null);
  const [tab, setTab] = useState<
    | 'activities'
    | 'documents'
    | 'attendance'
    | 'participants'
    | 'breakouts'
    | 'files'
    | 'presentations'
    | 'gallery'
    | 'geogebra'
    | 'sandbox'
  >(room.theme === 'immersive-glass' ? 'gallery' : 'documents');
  const shared = useSharedWorkspace(room.id);
  const appliedWorkspace = useRef(-1);
  useEffect(() => {
    const value = shared.workspace;
    if (!value || value.revision === appliedWorkspace.current) return;
    appliedWorkspace.current = value.revision;
    if (value.kind === 'geogebra') {
      setGeogebraOpened(true);
      setTab('geogebra');
    } else if (value.kind === 'sandbox') {
      setSandboxOpened(true);
      setTab('sandbox');
    } else if (value.kind === 'presentation') setTab('presentations');
    else {
      if (value.documentId) setDocId(value.documentId);
      setTab('documents');
    }
  }, [shared.workspace]);

  useEffect(() => {
    if (!docId && docs.length && !shared.workspace?.documentId)
      setDocId((docs.find((document) => document.kind === 'board') ?? docs[0]).id);
  }, [docs, docId]);

  const refreshVersion = useRef(0);
  const refreshAbort = useRef<AbortController | null>(null);
  async function refresh() {
    const version = ++refreshVersion.current;
    refreshAbort.current?.abort();
    const controller = (refreshAbort.current = new AbortController());
    try {
      const [s, d, p] = await Promise.allSettled([
        request<State>(base + '/teaching', undefined, { silent: true, signal: controller.signal }),
        request<Document[]>(base + '/documents', undefined, {
          silent: true,
          signal: controller.signal,
        }),
        request<PresentationState>(base + '/presentations', undefined, {
          silent: true,
          signal: controller.signal,
        }),
      ]);
      if (version !== refreshVersion.current || controller.signal.aborted) return;
      if (s.status === 'rejected') throw s.reason;
      setState(s.value);
      setOffset(s.value.serverTime - Date.now());
      if (d.status === 'fulfilled') setDocs(d.value);
      if (p.status === 'fulfilled') setPresentations(p.value);
      const failure = [d, p].find((result) => result.status === 'rejected');
      setError(failure?.status === 'rejected' ? failure.reason.message : '');
    } catch (e) {
      if (version === refreshVersion.current && !controller.signal.aborted) {
        setError((e as Error).message);
        if ([401, 403].includes((e as { status?: number }).status ?? 0)) {
          setAccessError((e as Error).message);
          setMedia(null);
        }
      }
    }
  }

  const connection = useClassroomConnection(
    room.id,
    (events) => {
      const ev = events?.find((e) => e.type === 'presentation_changed');
      if (events?.length === 1 && ev && typeof ev.revision === 'number' && 'current' in ev) {
        setPresentations((prev) => {
          if (!prev || prev.revision >= (ev.revision as number)) return prev;
          return {
            ...prev,
            revision: ev.revision as number,
            current: (ev.current as PresentationState['current']) ?? null,
          };
        });
        return;
      }
      void refresh();
    },
    [
      'document_changed',
      'presence_changed',
      'locks_changed',
      'selection_changed',
      'users_changed',
      'presentation_changed',
    ],
  );
  useEffect(() => {
    void refresh();
    const online = () => void refresh();
    window.addEventListener('online', online);
    const interval = setInterval(() => setClock(Date.now()), 250);
    return () => {
      clearInterval(interval);
      refreshVersion.current++;
      refreshAbort.current?.abort();
      window.removeEventListener('online', online);
    };
  }, [room.id]);

  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await request(base + path, body);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== 'attendance' && appsPage !== 'attendance') return;
    let cancelled = false;
    const load = async () => {
      try {
        const report = await request<NonNullable<typeof attendance>>(base + '/attendance');
        if (!cancelled) setAttendance(report);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tab, appsPage, base]);

  function exportAttendance() {
    if (!attendance) return;
    const quote = (v: string) =>
      '"' + (/^[=+@-]/.test(v) ? "'" : '') + v.replaceAll('"', '""') + '"';
    const csv =
      'Name,Duration seconds,Connections\n' +
      attendance.participants
        .map((p) =>
          [quote(p.name), Math.floor(p.totalDurationMs / 1000), p.connections.length].join(','),
        )
        .join('\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'attendance.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const manager = !!state && state.role !== 'student';
  const initialBoard = useRef(false);
  useEffect(() => {
    if (
      !manager ||
      initialBoard.current ||
      docs.some((d) => d.kind === 'board' && d.board_format === 'excalidraw')
    )
      return;
    initialBoard.current = true;
    void request<{ id: string }>(base + '/board-book', { name: t('board') })
      .then(async ({ id }) => {
        await openShared('document', id);
        await refresh();
      })
      .catch((e) => {
        initialBoard.current = false;
        setError(e.message);
      });
  }, [manager, docs]);
  const timer = state?.timer;
  const remaining =
    timer?.status === 'running' && timer.deadline
      ? Math.max(0, new Date(timer.deadline).getTime() - (clock + offset))
      : (timer?.remaining_ms ?? 0);

  async function createDocument(data: unknown) {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ id: string }>(base + '/documents', data);
      await openShared('document', result.id);
      setManageDocuments(false);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const activeDoc = docs.find((d) => d.id === docId);
  const bookId = activeDoc?.board_book_id ?? activeDoc?.id;
  const boardPages =
    activeDoc?.kind === 'board'
      ? docs
          .filter((d) => !d.page_archived && (d.id === bookId || d.board_book_id === bookId))
          .sort((a, b) => (a.board_page_index ?? 1) - (b.board_page_index ?? 1))
      : [];
  const pageIndex = boardPages.findIndex((d) => d.id === docId);
  const activeTheme: ClassroomTheme = state?.theme ?? room.theme ?? 'classic-bbb';
  useEffect(() => {
    if (!audioDialogOpen || !audioOffer) return;
    let active = true;
    void request<{ token: string; url: string; policy: AudioPolicy }>(
      base + '/join',
      {},
      { silent: true },
    )
      .then((offer) => {
        if (active) setAudioOffer(offer);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [state, audioDialogOpen]);
  async function chooseAudio(microphone: boolean) {
    const version = ++joinVersion.current;
    setJoining(true);
    setBusy(true);
    setError('');
    try {
      const offer = await request<{ token: string; url: string; policy: AudioPolicy }>(
        base + '/join',
        {},
      );
      if (version !== joinVersion.current) return;
      setAudioOffer(offer);
      if (microphone && !offer.policy.microphone) return;
      intent.current = { microphone, camera: false };
      setAudioDialogOpen(false);
      setMedia(offer);
      hadMedia.current = true;
    } catch (error) {
      if (version === joinVersion.current) setError((error as Error).message);
    } finally {
      if (version === joinVersion.current) {
        setJoining(false);
        setBusy(false);
      }
    }
  }
  const panelLayout = useClassroomPanelLayout(activeTheme, i18n.language.startsWith('fa'));
  const activePermissions: ClassroomPermissions =
    state?.permissions ?? room.permissions ?? DEFAULT_CLASSROOM_PERMISSIONS;
  const myPermissions: UserEffectivePermissions = state?.myPermissions ?? {
    canChat: manager || activePermissions.chatEnabled,
    canChatImages: manager,
    canSharedNotes: true,
    interactionLocked: false,
    canWhiteboard: manager || activePermissions.studentWhiteboardEnabled,
    canMicrophone: manager || activePermissions.defaultMicrophone,
    canCamera: manager || activePermissions.defaultCamera,
    canScreenShare: manager || activePermissions.defaultScreenShare,
    canRaiseHand: manager || activePermissions.handRaiseEnabled,
    isPresenter: manager,
    kicked: false,
  };
  const canPresent = manager || myPermissions.isPresenter;
  function showSharedDocuments() {
    if (canPresent) {
      void openShared('document');
      return;
    }
    // Viewers may open the current shared document without changing the
    // document selected for the rest of the class.
    const current = shared.workspace;
    if (current?.kind === 'document' && current.documentId) setDocId(current.documentId);
    setTab('documents');
  }
  function selectVisibleDocument(id: string) {
    if (canPresent) {
      void openShared('document', id);
      return;
    }
    // A viewer can open the document already shared with the classroom, while
    // selecting a different document remains a presenter-only action.
    if (shared.workspace?.kind === 'document' && shared.workspace.documentId === id) {
      setDocId(id);
      setTab('documents');
    }
  }
  async function openShared(
    kind: 'document' | 'geogebra' | 'presentation' | 'sandbox',
    documentId = docId,
    geogebraId = shared.workspace?.geogebraId ?? null,
    sandboxId = shared.workspace?.sandboxId ?? null,
  ) {
    if (!canPresent) return;
    if (kind === 'document' && !documentId) return;
    try {
      await boardSync.current?.();
      if (kind === 'document') {
        const chosen = docs.find((d) => d.id === documentId);
        if (chosen?.page_archived)
          documentId = docs
            .filter(
              (d) =>
                !d.page_archived &&
                (d.id === chosen.id || d.board_book_id === (chosen.board_book_id ?? chosen.id)),
            )
            .sort((a, b) => (a.board_page_index ?? 1) - (b.board_page_index ?? 1))[0]?.id;
        if (!documentId) return;
      }
      await shared.select({
        kind,
        ...(kind === 'document' ? { documentId } : {}),
        ...(kind === 'geogebra' ? { geogebraId } : {}),
        ...(kind === 'sandbox' ? { sandboxId } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const myStatus: ParticipantStatusKind =
    state?.statuses?.find((s) => s.user_id === state.userId)?.status ?? 'none';

  async function patchIndividualUser(userId: string, patch: Record<string, boolean | null>) {
    await action(`/user-permissions/${userId}`, patch);
  }

  async function bulkUpdatePermissions(patch: Record<string, boolean>) {
    await action('/user-permissions-bulk', patch);
  }

  function pickRandomStudent() {
    void action('/random-student', {});
  }

  async function saveRoomSettings(closeDialog = true) {
    setBusy(true);
    setError('');
    try {
      await request(base + '/notice', {
        pinnedNotice: draftNotice,
        externalMediaUrl: draftExternalUrl,
      });
      if (closeDialog) setSettingsOpen(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state || accessError)
    return (
      <>
        {/* A reassignment revokes the old child room before its redirect arrives.
          Keep the authorized parent resolver alive through the loading state. */}
        {room.parent && <BreakoutStatus room={room} onNavigate={move} hidden />}
        <ClassroomLoading
          error={accessError || error}
          onRetry={() => {
            setError('');
            setAccessError('');
            void refresh();
          }}
          onLeave={onLeave}
        />
      </>
    );

  const allParticipants = state.participants ?? [];
  const filteredParticipants = allParticipants.filter((person) => {
    if (peopleSearch.trim()) {
      const q = peopleSearch.trim().toLowerCase();
      if (!person.name.toLowerCase().includes(q)) return false;
    }
    if (peopleFilter === 'hands') {
      return state.hands.some((h) => h.user_id === person.id);
    }
    if (peopleFilter === 'speaking') {
      return speakers.has(person.id);
    }
    return true;
  });

  const moderatorIds = allParticipants.filter((p) => p.role !== 'student').map((p) => p.id);
  const peoplePages = Math.max(1, Math.ceil(filteredParticipants.length / 50));
  const currentPeoplePage = Math.min(peoplePage, peoplePages - 1);
  const visibleParticipants = filteredParticipants.slice(
    currentPeoplePage * 50,
    (currentPeoplePage + 1) * 50,
  );

  return (
    <div
      ref={shell}
      style={panelLayout.style}
      data-expanded-panel={panelLayout.expanded ?? 'none'}
      dir={i18n.language.startsWith('fa') ? 'rtl' : 'ltr'}
      data-theme={activeTheme}
      data-sidepanel={sidePanel ?? 'none'}
      data-compact-layout={compact}
      data-gallery={tab === 'gallery'}
      data-hide-chat={closedPanels.has('chat')}
      data-hide-people={closedPanels.has('people')}
      className={
        'teaching classroom-shell' +
        (sidePanel ? ' has-panel' : '') +
        (media ? ' has-media' : '') +
        (screenSharing ? ' sharing-screen' : '')
      }
    >
      {lockPopoverOpen && (
        <ClassroomLockDialog
          roomId={room.id}
          target={lockTarget}
          onClose={() => setLockPopoverOpen(false)}
          onSaved={refresh}
        />
      )}
      <header className="teaching-header classroom-topbar">
        <div className="classroom-meeting-name">
          <h1>{room.name}</h1>
          {activeTheme === 'studio-hybrid' && <span className="studio-pro-badge">STUDIO PRO</span>}
          <ConnectionSignal state={connection} />
          {activePermissions.locked && (
            <span className="classroom-lock-pill">
              <ClassIcon name="lock" /> {t('permLockedBadge')}
            </span>
          )}
          {timer?.status === 'running' && remaining > 0 && (
            <span className="skyroom-timer-pill" title={t('timer')}>
              <ClassIcon name="clock" size={13} />
              <span>
                {String(Math.floor(remaining / 60000)).padStart(2, '0')}:
                {String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}
              </span>
            </span>
          )}
        </div>
        <nav className="classroom-header-tabs" aria-label={t('classNavigation')}>
          <button
            aria-pressed={tab === 'documents'}
            disabled={canPresent && shared.busy}
            onClick={showSharedDocuments}
          >
            <ClassIcon name="board" />
            {t('documents')}
          </button>
          <button
            aria-pressed={tab === 'presentations'}
            disabled={!canPresent || shared.busy}
            onClick={() => void openShared('presentation')}
          >
            <ClassIcon name="slides" />
            {t('presentationLibrary')}
          </button>
          <button aria-pressed={tab === 'gallery'} onClick={() => setTab('gallery')}>
            <ClassIcon name="video" />
            {t('classroomGallery')}
          </button>
        </nav>
        <div className="classroom-session-state">
          <h2>{t(state.session ? 'sessionActive' : 'sessionInactive')}</h2>
          {state.session?.started_at && (
            <time>
              {new Intl.DateTimeFormat(i18n.language, {
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(state.session.started_at))}
            </time>
          )}
        </div>
        <div className="classroom-header-actions">
          {panelLayout.preferences}
          {manager && (
            <button
              className="classroom-header-icon classroom-lock-button"
              aria-label={t('studentPermissions')}
              title={t('studentPermissions')}
              aria-haspopup="dialog"
              onClick={() => {
                setLockTarget(undefined);
                setLockPopoverOpen(true);
              }}
            >
              <ClassIcon name="shield" />
            </button>
          )}
          <button
            className="classroom-sound-toggle"
            aria-label={t('classroomSounds')}
            title={t('classroomSounds')}
            aria-pressed={sounds}
            onClick={toggleSounds}
          >
            <ClassIcon name={sounds ? 'audio' : 'volumeOff'} />
          </button>
          <button
            className="classroom-panel-toggle"
            aria-label={t('participants')}
            aria-pressed={panelOpen('people')}
            onClick={() => togglePanel('people')}
          >
            <ClassIcon name="people" />
          </button>
          <button
            className="classroom-panel-toggle"
            aria-label={t('chat')}
            aria-pressed={panelOpen('chat')}
            onClick={() => togglePanel('chat')}
          >
            <ClassIcon name="chat" />
          </button>
          {manager && (
            <button
              type="button"
              className="classroom-theme-button"
              aria-label={t('classroomAnnouncements')}
              title={t('classroomAnnouncements')}
              onClick={() => setSettingsOpen(true)}
            >
              <ClassIcon name="notes" />
              <span>{t('classroomAnnouncements')}</span>
            </button>
          )}
          {manager && !room.parent && (
            <button
              className="classroom-session-button"
              aria-label={t(state.session ? 'endSession' : 'startSession')}
              disabled={busy}
              onClick={() => void action('/session/' + (state.session ? 'end' : 'start'), {})}
            >
              <ClassIcon name={state.session ? 'leave' : 'play'} />
              <span>{t(state.session ? 'endSession' : 'startSession')}</span>
            </button>
          )}
          <button
            className="classroom-header-icon"
            aria-label={t('classFullscreen')}
            title={t('classFullscreen')}
            onClick={() => {
              void (
                document.fullscreenElement
                  ? document.exitFullscreen()
                  : shell.current?.requestFullscreen()
              )?.catch((error) => setError(error.message));
            }}
          >
            <ClassIcon name="expand" />
          </button>
        </div>
      </header>
      <AudioJoinDialog
        open={audioDialogOpen}
        policy={audioOffer?.policy}
        busy={joining}
        error={error}
        onChoose={(microphone) => void chooseAudio(microphone)}
        onCancel={cancelJoin}
      />
      <dialog
        ref={settingsDialog}
        className="classroom-dialog classroom-settings-dialog"
        onClose={() => setSettingsOpen(false)}
      >
        <header>
          <h2>{t('classroomAnnouncements')}</h2>
          <button aria-label={t('classClosePanel')} onClick={() => setSettingsOpen(false)}>
            <ClassIcon name="close" />
          </button>
        </header>
        {manager && (
          <div className="classroom-settings-body">
            <h3>{t('classroomBroadcastNoticeTitle')}</h3>
            <div className="notice-settings-grid">
              <label>
                {t('pinnedNoticeLabel')}
                <input
                  value={draftNotice}
                  maxLength={500}
                  placeholder={t('pinnedNoticePlaceholder')}
                  onChange={(e) => setDraftNotice(e.target.value)}
                />
              </label>
              <label>
                {t('externalMediaUrlLabel')}
                <input
                  value={draftExternalUrl}
                  maxLength={500}
                  placeholder="https://..."
                  onChange={(e) => setDraftExternalUrl(e.target.value)}
                />
              </label>
            </div>
            <div className="actions">
              <button type="button" className="quiet" onClick={() => setSettingsOpen(false)}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void saveRoomSettings()}
              >
                {t('adminSaveRoomSettings')}
              </button>
            </div>
          </div>
        )}
      </dialog>
      <BreakoutStatus room={room} onNavigate={move} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <nav className="classroom-rail" aria-label={t('classNavigation')}>
        <div className="classroom-brand" aria-label="TOASTER">
          <span>T</span>
        </div>
        <button
          aria-label={t('participants')}
          title={t('participants')}
          aria-pressed={panelOpen('people')}
          onClick={() => togglePanel('people')}
        >
          <ClassIcon name="people" />
          <span>{t('participants')}</span>
          {state.participants && (
            <b>{new Intl.NumberFormat(i18n.language).format(state.participants.length)}</b>
          )}
        </button>
        <button
          aria-label={t('chat')}
          title={t('chat')}
          aria-pressed={panelOpen('chat')}
          onClick={() => togglePanel('chat')}
        >
          <ClassIcon name="chat" />
          <span>{t('chat')}</span>
        </button>
        <div className="classroom-rail-divider" />
        <button
          aria-label={t('documents')}
          title={t('documents')}
          aria-pressed={tab === 'documents'}
          disabled={canPresent && shared.busy}
          onClick={showSharedDocuments}
        >
          <ClassIcon name="board" />
          <span>{t('documents')}</span>
        </button>
        {presentations?.enabled && (
          <button
            aria-label={t('presentationLibrary')}
            title={t('presentationLibrary')}
            aria-pressed={tab === 'presentations'}
            disabled={!canPresent || shared.busy}
            onClick={() => void openShared('presentation')}
          >
            <ClassIcon name="slides" />
            <span>{t('presentationLibrary')}</span>
          </button>
        )}
        <button
          aria-label={t('activities')}
          title={t('classApps')}
          aria-pressed={sidePanel === 'apps'}
          onClick={toggleAppsPanel}
        >
          <ClassIcon name="apps" />
          <span>{t('classApps')}</span>
        </button>
        <div className="classroom-rail-spacer" />
        <span className="classroom-rail-mark">TOASTER</span>
        <button
          aria-label={t('classroomGallery')}
          title={t('classroomGallery')}
          aria-pressed={tab === 'gallery'}
          onClick={() => setTab('gallery')}
        >
          <ClassIcon name="video" />
          <span>{t('classroomGallery')}</span>
        </button>
      </nav>
      <aside
        data-layout-panel="chat"
        className={
          'classroom-sidepanel classroom-chat-panel' + (sidePanel === 'chat' ? ' is-open' : '')
        }
      >
        <header>
          <h2>{t('chat')}</h2>
          {panelLayout.controls('chat')}
          <button aria-label={t('classClosePanel')} onClick={() => closePanel('chat')}>
            <ClassIcon name="close" />
          </button>
        </header>
        <Chat
          key={room.id + ':' + state.userId}
          roomId={room.id}
          userId={state.userId}
          canWrite={manager}
          chatEnabled={myPermissions.canChat}
          canSendImages={myPermissions.canChatImages}
          moderatorIds={moderatorIds}
        />
        {panelLayout.separator('chat')}
      </aside>
      <aside
        data-layout-panel="people"
        data-app-mode={sidePanel === 'apps' ? 'true' : 'false'}
        className={
          'classroom-sidepanel classroom-people-panel' +
          (sidePanel === 'people' || sidePanel === 'apps' ? ' is-open' : '')
        }
      >
        <header>
          <h2>
            {sidePanel === 'apps'
              ? t(appsPage ? classroomAppTitles[appsPage] : 'classApps')
              : t('participants')}
            {sidePanel !== 'apps' && <small>{state.participants?.length ?? 0}</small>}
          </h2>
          {panelLayout.controls('people')}
          {sidePanel === 'apps' && appsPage ? (
            <button
              className="quiet classroom-app-back"
              aria-label={t('back')}
              onClick={() => setAppsPage(null)}
            >
              {t('back')}
            </button>
          ) : (
            <button aria-label={t('classClosePanel')} onClick={() => closePanel('people')}>
              <ClassIcon name="close" />
            </button>
          )}
        </header>
        {sidePanel === 'apps' && (
          <div
            className="classroom-app-size-controls"
            role="group"
            aria-label={t('classroomTextSize')}
          >
            <span>{t('classroomTextSize')}</span>
            <button
              type="button"
              title={t('contentSmaller')}
              aria-label={t('contentSmaller')}
              disabled={appContentZoom <= 0.8}
              onClick={() =>
                setAppContentZoom((size) => Math.max(0.8, Math.round((size - 0.1) * 10) / 10))
              }
            >
              A−
            </button>
            <output>{Math.round(appContentZoom * 100)}%</output>
            <button
              type="button"
              title={t('contentLarger')}
              aria-label={t('contentLarger')}
              disabled={appContentZoom >= 1.5}
              onClick={() =>
                setAppContentZoom((size) => Math.min(1.5, Math.round((size + 0.1) * 10) / 10))
              }
            >
              A+
            </button>
          </div>
        )}
        <div className={'classroom-people' + (sidePanel === 'apps' ? ' is-hidden-for-apps' : '')}>
          <div className="people-search-box">
            <ClassIcon name="search" size={13} />
            <input
              type="search"
              placeholder={t('searchMembersPlaceholder')}
              aria-label={t('searchMembersPlaceholder')}
              value={peopleSearch}
              onChange={(e) => setPeopleSearch(e.target.value)}
            />
          </div>

          <div className="people-filter-tabs" role="tablist">
            <button
              type="button"
              className={peopleFilter === 'all' ? 'is-active' : 'quiet'}
              onClick={() => setPeopleFilter('all')}
            >
              {t('allParticipants')} ({allParticipants.length})
            </button>
            <button
              type="button"
              className={peopleFilter === 'hands' ? 'is-active' : 'quiet'}
              onClick={() => setPeopleFilter('hands')}
            >
              {t('raisedHands')} ({state.hands.length})
            </button>
            <button
              type="button"
              className={peopleFilter === 'speaking' ? 'is-active' : 'quiet'}
              onClick={() => setPeopleFilter('speaking')}
            >
              {t('currentlySpeaking')} ({speakers.size})
            </button>
          </div>

          {manager && (
            <div className="classroom-moderator-bar">
              <button
                type="button"
                className="quiet"
                onClick={pickRandomStudent}
                title={t('pickRandomStudent')}
              >
                <ClassIcon name="sparkle" size={12} /> <span>{t('pickRandomStudent')}</span>
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  void action('/status', { clearAll: true });
                  if (state.session) void action('/hand', { clearAll: true });
                }}
                title={t('clearAllStatuses')}
              >
                <ClassIcon name="check" size={12} /> <span>{t('clearAllStatuses')}</span>
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void bulkUpdatePermissions({ canMicrophone: false })}
                title={t('muteAllStudents')}
              >
                <ClassIcon name="micOff" size={12} /> <span>{t('muteAllStudents')}</span>
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void bulkUpdatePermissions({ resetOverrides: true })}
                title={t('resetStudentPermissions')}
              >
                <ClassIcon name="unlock" size={12} /> <span>{t('resetStudentPermissions')}</span>
              </button>
            </div>
          )}
          {randomStudent && (
            <div className="random-student-banner" role="status">
              <span>
                {t('selectedRandomStudent')}: <strong>{randomStudent}</strong>
              </span>
              {manager && (
                <button
                  type="button"
                  className="quiet"
                  aria-label={t('clearRandomSelection')}
                  onClick={() => void action('/random-student', { clear: true })}
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div className="classroom-status-picker" role="group" aria-label={t('myStatusLabel')}>
            {(
              [
                { key: 'agree', emoji: '👍', label: 'statusAgree' },
                { key: 'disagree', emoji: '👎', label: 'statusDisagree' },
                { key: 'applause', emoji: '👏', label: 'statusApplause' },
                { key: 'confused', emoji: '😕', label: 'statusConfused' },
                { key: 'away', emoji: '☕', label: 'statusAway' },
              ] as const
            ).map((st) => (
              <button
                key={st.key}
                type="button"
                aria-pressed={myStatus === st.key}
                title={t(st.label)}
                className={myStatus === st.key ? 'active' : ''}
                onClick={() =>
                  void action('/status', {
                    status: myStatus === st.key ? 'none' : st.key,
                  })
                }
              >
                <span>{st.emoji}</span>
              </button>
            ))}
          </div>
          <p className="classroom-sidebar-label">{t('classOnlineUsers')}</p>
          <ul>
            {visibleParticipants.map((person) => {
              const hasHand = state.hands.some((h) => h.user_id === person.id);
              const statusKind =
                state.statuses?.find((s) => s.user_id === person.id)?.status ?? 'none';
              const statusEmoji = STATUS_EMOJIS[statusKind] || '';
              const uPerm = state.userPermissions?.find((p) => p.userId === person.id);
              const isStudent = person.role === 'student';
              const interactionLocked = isStudent && Boolean(uPerm?.interactionLocked);
              const denied = (key: keyof NonNullable<State['locks']>['locks']) =>
                interactionLocked ||
                (isStudent && !uPerm?.lockExempt && Boolean(state.locks?.locks[key]));
              const effImages =
                !denied('chatImages') && !denied('chat') && (uPerm?.canChatImages ?? false);
              const effChat = !denied('chat') && (uPerm?.canChat ?? activePermissions.chatEnabled);
              const effBoard =
                !denied('whiteboard') &&
                uPerm?.canWhiteboard !== false &&
                (Boolean(uPerm?.isPresenter) ||
                  (uPerm?.canWhiteboard ?? activePermissions.studentWhiteboardEnabled));
              const effMic =
                !denied('microphone') &&
                (uPerm?.canMicrophone ?? activePermissions.defaultMicrophone);
              const effCam =
                !denied('camera') && (uPerm?.canCamera ?? activePermissions.defaultCamera);
              const effScreen =
                !denied('screenShare') &&
                uPerm?.canScreenShare !== false &&
                (Boolean(uPerm?.isPresenter) ||
                  (uPerm?.canScreenShare ?? activePermissions.defaultScreenShare));
              return (
                <li
                  key={person.id}
                  className={
                    'participant-item' +
                    (speakers.has(person.id) ? ' is-speaking' : '') +
                    (!isStudent ? ' is-moderator' : '')
                  }
                  data-participant-id={person.id}
                  data-speaking={speakers.has(person.id)}
                  data-microphone={participantMedia.get(person.id)?.microphone ?? false}
                >
                  <div className="participant-main-row">
                    <span
                      className="classroom-avatar"
                      style={participantAvatarStyle(person.id, !isStudent)}
                      data-role={!isStudent ? 'moderator' : 'viewer'}
                      aria-hidden="true"
                    >
                      {person.name
                        .trim()
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join('')}
                    </span>
                    <div>
                      <strong
                        title={person.name}
                        role={manager && isStudent ? 'button' : undefined}
                        tabIndex={manager && isStudent ? 0 : undefined}
                        aria-expanded={
                          manager && isStudent ? selectedParticipant === person.id : undefined
                        }
                        onClick={() => {
                          if (manager && isStudent)
                            setSelectedParticipant((current) =>
                              current === person.id ? undefined : person.id,
                            );
                        }}
                        onKeyDown={(event) => {
                          if (
                            manager &&
                            isStudent &&
                            (event.key === 'Enter' || event.key === ' ')
                          ) {
                            event.preventDefault();
                            setSelectedParticipant((current) =>
                              current === person.id ? undefined : person.id,
                            );
                          }
                        }}
                      >
                        {person.name} {hasHand ? '✋' : ''} {statusEmoji}
                        {(uPerm?.isPresenter || !isStudent) && (
                          <span className="perm-badge presenter" title={t('presenterBadge')}>
                            <ClassIcon name="presenter" size={11} />
                          </span>
                        )}
                      </strong>
                      <small>
                        {t(
                          person.role === 'owner'
                            ? 'owner'
                            : isStudent
                              ? 'studentRole'
                              : 'teacherRole',
                        )}
                        {person.id === state.userId ? ' · ' + t('classYou') : ''}
                      </small>
                      <span
                        className="participant-media-status"
                        aria-label={t('mediaStatus') + ' - ' + person.name}
                      >
                        <span
                          title={
                            t('microphone') +
                            ' · ' +
                            t(
                              participantMedia.get(person.id)?.microphone
                                ? 'mediaEnabled'
                                : 'mediaDisabled',
                            )
                          }
                        >
                          <ClassIcon
                            name={participantMedia.get(person.id)?.microphone ? 'mic' : 'micOff'}
                            size={14}
                          />
                          <span className="sr-only">
                            {t('microphone')}:{' '}
                            {t(
                              participantMedia.get(person.id)?.microphone
                                ? 'mediaEnabled'
                                : 'mediaDisabled',
                            )}
                          </span>
                        </span>
                        <span
                          title={
                            t('camera') +
                            ' · ' +
                            t(
                              participantMedia.get(person.id)?.camera
                                ? 'mediaEnabled'
                                : 'mediaDisabled',
                            )
                          }
                        >
                          <ClassIcon
                            name={participantMedia.get(person.id)?.camera ? 'cam' : 'camOff'}
                            size={14}
                          />
                        </span>
                        {participantMedia.get(person.id)?.screenShare && (
                          <span title={t('sharingScreen')}>
                            <ClassIcon name="screen" size={14} />
                          </span>
                        )}
                      </span>
                    </div>
                    {hasHand && manager && isStudent ? (
                      <button
                        type="button"
                        className="btn-grant-speech-inline"
                        disabled={busy}
                        title={t('grantSpeechAndLowerHand')}
                        onClick={() =>
                          void patchIndividualUser(person.id, {
                            canMicrophone: true,
                            lowerHand: true,
                          })
                        }
                      >
                        <ClassIcon name="mic" size={12} />
                        <span>{t('grantSpeech')}</span>
                      </button>
                    ) : (
                      <span className="classroom-online-dot" title={t('liveConnected')} />
                    )}
                  </div>
                  {manager && isStudent && selectedParticipant === person.id && (
                    <div
                      className="participant-inline-perms"
                      role="group"
                      aria-label={`${t('individualUserPermissionsTitle')} ${person.name}`}
                    >
                      <button
                        type="button"
                        className={'mini-perm-btn' + (interactionLocked ? ' is-on' : '')}
                        title={t(interactionLocked ? 'participantUnlock' : 'participantLock')}
                        aria-label={t(interactionLocked ? 'participantUnlock' : 'participantLock')}
                        disabled={busy}
                        onClick={() => {
                          setLockTarget({ id: person.id, name: person.name });
                          setLockPopoverOpen(true);
                        }}
                      >
                        <ClassIcon name={interactionLocked ? 'lock' : 'unlock'} size={13} />
                      </button>
                      <button
                        type="button"
                        className={'mini-perm-btn' + (effImages ? ' is-on' : '')}
                        title={t('chatImagePermission')}
                        aria-label={t('chatImagePermission')}
                        disabled={busy}
                        onClick={() =>
                          void patchIndividualUser(person.id, { canChatImages: !effImages })
                        }
                      >
                        <ClassIcon name="image" size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${uPerm?.isPresenter ? ' is-on presenter' : ''}`}
                        title={t('togglePresenterRole')}
                        aria-label={t('togglePresenterRole') + ' - ' + person.name}
                        onClick={() =>
                          void patchIndividualUser(person.id, {
                            isPresenter: !uPerm?.isPresenter,
                            ...(!uPerm?.isPresenter && uPerm?.canWhiteboard === false
                              ? { canWhiteboard: null }
                              : {}),
                            ...(!uPerm?.isPresenter && uPerm?.canScreenShare === false
                              ? { canScreenShare: null }
                              : {}),
                          })
                        }
                      >
                        <ClassIcon name="presenter" size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${effBoard ? ' is-on' : ' is-off'}`}
                        title={t('permUserWhiteboard')}
                        aria-label={t('permUserWhiteboard') + ' - ' + person.name}
                        onClick={() =>
                          void patchIndividualUser(person.id, { canWhiteboard: !effBoard })
                        }
                      >
                        <ClassIcon name="pen" size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${effChat ? ' is-on' : ' is-off'}`}
                        title={t('permUserChat')}
                        aria-label={t('permUserChat') + ' - ' + person.name}
                        onClick={() => void patchIndividualUser(person.id, { canChat: !effChat })}
                      >
                        <ClassIcon name="chat" size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${effMic ? ' is-on' : ' is-off'}`}
                        title={t('microphone')}
                        aria-label={t('microphone') + ' - ' + person.name}
                        onClick={() =>
                          void patchIndividualUser(person.id, { canMicrophone: !effMic })
                        }
                      >
                        <ClassIcon name={effMic ? 'mic' : 'micOff'} size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${effCam ? ' is-on' : ' is-off'}`}
                        title={t('camera')}
                        aria-label={t('camera') + ' - ' + person.name}
                        onClick={() => void patchIndividualUser(person.id, { canCamera: !effCam })}
                      >
                        <ClassIcon name={effCam ? 'cam' : 'camOff'} size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`mini-perm-btn${effScreen ? ' is-on' : ' is-off'}`}
                        title={t('shareScreen')}
                        aria-label={t('shareScreen') + ' - ' + person.name}
                        onClick={() =>
                          void patchIndividualUser(person.id, { canScreenShare: !effScreen })
                        }
                      >
                        <ClassIcon name="screen" size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="mini-perm-btn is-danger"
                        title={t('permUserKick')}
                        aria-label={t('permUserKick') + ' - ' + person.name}
                        onClick={() => void patchIndividualUser(person.id, { kicked: true })}
                      >
                        <ClassIcon name="kick" size={13} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {peoplePages > 1 && (
            <nav className="classroom-pagination" aria-label={t('participants')}>
              <button
                disabled={currentPeoplePage === 0}
                onClick={() => setPeoplePage(currentPeoplePage - 1)}
              >
                {t('previousPage')}
              </button>
              <span>{t('pageOf', { page: currentPeoplePage + 1, total: peoplePages })}</span>
              <button
                disabled={currentPeoplePage >= peoplePages - 1}
                onClick={() => setPeoplePage(currentPeoplePage + 1)}
              >
                {t('nextPage')}
              </button>
            </nav>
          )}
          {!filteredParticipants.length && <p>{t('classNoOnlineUsers')}</p>}
          {manager && (
            <details className="classroom-moderation">
              <summary>{t('individualUserPermissionsTitle')}</summary>
              <IndividualUserPermissionsManager roomId={room.id} onChanged={() => void refresh()} />
            </details>
          )}
          <details className="classroom-moderation">
            <summary>{t('classMediaPermissions')}</summary>
            <MediaModeration roomId={room.id} manager={manager} userId={state.userId} />
          </details>
        </div>
        {sidePanel === 'apps' && !appsPage && (
          <div
            className="classroom-apps-sidebar"
            role="menu"
            aria-label={t('classApps')}
            style={{ zoom: appContentZoom }}
          >
            {(
              [
                { key: 'activities', icon: 'apps', label: 'activities' },
                { key: 'files', icon: 'files', label: 'fileLibrary' },
                ...(options.geoEnabled
                  ? [{ key: 'geogebra', icon: 'shape', label: 'geoTitle' }]
                  : []),
                { key: 'sandbox', icon: 'board', label: 'sandboxTitle' },
                ...(!room.parent
                  ? [{ key: 'breakouts', icon: 'people', label: 'breakoutRooms' }]
                  : []),
                ...(manager ? [{ key: 'attendance', icon: 'clock', label: 'attendance' }] : []),
                ...(manager
                  ? [{ key: 'announcements', icon: 'notes', label: 'classroomAnnouncements' }]
                  : []),
              ] as const
            ).map((item) => (
              <button
                role="menuitem"
                key={item.key}
                disabled={
                  (item.key === 'geogebra' || item.key === 'sandbox') &&
                  (!canPresent || shared.busy)
                }
                onClick={() => setAppsPage(item.key as ClassroomAppKey)}
              >
                <ClassIcon name={item.icon as 'apps'} size={18} />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        )}
        {sidePanel === 'apps' && appsPage && (
          <div className="classroom-app-page" style={{ zoom: appContentZoom }}>
            {appsPage === 'files' && (
              <Suspense fallback={<p role="status">{t('loading')}</p>}>
                <Files
                  resource="classrooms"
                  id={room.id}
                  onPresentFile={
                    presentations?.enabled
                      ? async (fileId) => {
                          setBusy(true);
                          setError('');
                          try {
                            await request(base + '/presentations', { fileId });
                            await openShared('presentation');
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }
                      : undefined
                  }
                />
              </Suspense>
            )}
            {appsPage === 'geogebra' && options.geoEnabled && (
              <Suspense fallback={<p role="status">{t('geoLoading')}</p>}>
                <GeoGebraWorkspace
                  roomId={room.id}
                  userId={state.userId}
                  manager={manager}
                  canEdit={myPermissions.canWhiteboard}
                  selectedId={shared.workspace?.geogebraId ?? null}
                  perspective={shared.workspace?.geoPerspective ?? '1'}
                  onPerspective={async (value) => {
                    try {
                      await shared.select({
                        kind: 'geogebra',
                        geogebraId: shared.workspace?.geogebraId ?? null,
                        geoPerspective: value,
                      });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  canSelect={canPresent}
                  onSelect={async (id) => {
                    await openShared('geogebra', undefined, id);
                  }}
                />
              </Suspense>
            )}
            {appsPage === 'sandbox' && (
              <Suspense fallback={<p role="status">{t('sandboxLoading')}</p>}>
                <SandboxWorkspace
                  roomId={room.id}
                  selectedId={shared.workspace?.sandboxId ?? null}
                  canSelect={canPresent}
                  onSelect={async (id) => {
                    await openShared('sandbox', undefined, undefined, id);
                  }}
                />
              </Suspense>
            )}
            {appsPage === 'breakouts' && !room.parent && (
              <Breakouts room={room} onNavigate={move} />
            )}
            {appsPage === 'attendance' && manager && (
              <section className="classroom-app-section">
                <div className="section-heading">
                  <h3>{t('attendance')}</h3>
                  <button onClick={exportAttendance} disabled={!attendance?.participants.length}>
                    {t('exportCsv')}
                  </button>
                </div>
                <p>{t('attendanceHelp')}</p>
                {attendance ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('name')}</th>
                          <th>{t('attendanceDuration')}</th>
                          <th>{t('connections')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attendance.participants.map((person) => (
                          <tr key={person.userId}>
                            <td>{person.name}</td>
                            <td>
                              {new Intl.NumberFormat(i18n.language, {
                                maximumFractionDigits: 1,
                              }).format(person.totalDurationMs / 60000)}{' '}
                              {t('minutes')}
                            </td>
                            <td>{person.connections.length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!attendance.participants.length && <p>{t('noAttendance')}</p>}
                  </div>
                ) : (
                  <p role="status">{t('loading')}</p>
                )}
              </section>
            )}
            {appsPage === 'announcements' && manager && (
              <section className="classroom-app-section">
                <h3>{t('classroomBroadcastNoticeTitle')}</h3>
                <label>
                  {t('pinnedNoticeLabel')}
                  <textarea
                    value={draftNotice}
                    maxLength={500}
                    rows={4}
                    onChange={(event) => setDraftNotice(event.target.value)}
                  />
                </label>
                <label>
                  {t('externalMediaUrlLabel')}
                  <input
                    value={draftExternalUrl}
                    maxLength={500}
                    onChange={(event) => setDraftExternalUrl(event.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void saveRoomSettings(false)}
                >
                  {t('adminSaveRoomSettings')}
                </button>
              </section>
            )}
            {appsPage === 'activities' && (
              <div className="classroom-app-activities">
                <section className="classroom-app-section">
                  <h3>
                    {t('handQueue')} ({state.hands.length})
                  </h3>
                  {state.hands.length ? (
                    <ul>
                      {state.hands.map((hand) => (
                        <li key={hand.user_id}>
                          <span>{hand.name}</span>
                          {manager && (
                            <button
                              aria-label={t('lowerHand') + ' ' + hand.name}
                              disabled={busy}
                              onClick={() =>
                                void action('/hand', { raised: false, userId: hand.user_id })
                              }
                            >
                              {t('lowerHand')}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t('noHands')}</p>
                  )}
                </section>
                <section className="classroom-app-section">
                  <h3>{t('timer')}</h3>
                  <output className="timer-display" aria-label={t('timer')}>
                    {String(Math.floor(remaining / 60000)).padStart(2, '0')}:
                    {String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}
                  </output>
                  {manager && (
                    <>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void action('/timer', {
                            action: 'start',
                            durationSeconds: Number(
                              new FormData(event.currentTarget).get('seconds'),
                            ),
                          });
                        }}
                      >
                        <label>
                          {t('durationSeconds')}
                          <input
                            name="seconds"
                            type="number"
                            min={1}
                            max={86400}
                            defaultValue={300}
                          />
                        </label>
                        <button disabled={busy}>{t('startTimer')}</button>
                      </form>
                      {timer && (
                        <div className="actions">
                          <button
                            disabled={busy || timer.status === 'stopped' || remaining === 0}
                            onClick={() =>
                              void action('/timer', {
                                action: timer.status === 'running' ? 'pause' : 'resume',
                              })
                            }
                          >
                            {t(timer.status === 'running' ? 'pause' : 'resume')}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void action('/timer', { action: 'reset' })}
                          >
                            {t('reset')}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
                <section className="classroom-app-section">
                  <h3>{t('polls')}</h3>
                  {manager && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void action('/polls', {
                          question: form.get('question'),
                          options: String(form.get('options'))
                            .split('\n')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        });
                        event.currentTarget.reset();
                      }}
                    >
                      <label>
                        {t('question')}
                        <input name="question" required maxLength={500} />
                      </label>
                      <label>
                        {t('pollOptions')}
                        <textarea name="options" required rows={3} maxLength={2400} />
                      </label>
                      <button className="primary" disabled={busy}>
                        {t('launchPoll')}
                      </button>
                    </form>
                  )}
                  {state.polls.map((poll) => (
                    <article className="poll" key={poll.id}>
                      <h4>{poll.question}</h4>
                      {poll.options.map((option, index) => (
                        <button
                          key={index}
                          disabled={busy || poll.status !== 'open' || poll.myChoice !== null}
                          aria-pressed={poll.myChoice === index}
                          onClick={() =>
                            void action('/polls/' + poll.id + '/vote', { choice: index })
                          }
                        >
                          {option}
                          {poll.counts && <span>{poll.counts[index]}</span>}
                        </button>
                      ))}
                    </article>
                  ))}
                  {!state.polls.length && <p>{t('noPolls')}</p>}
                </section>
              </div>
            )}
          </div>
        )}
        {panelLayout.separator('people')}
      </aside>
      <section className="classroom-tools-panel">
        <h2>{t('classroomTools')}</h2>
        <div>
          {(
            [
              ['activities', 'apps', 'activities'],
              ['files', 'files', 'fileLibrary'],
              ...(!room.parent ? [['breakouts', 'people', 'breakoutRooms']] : []),
              ...(manager ? [['attendance', 'clock', 'attendance']] : []),
            ] as const
          ).map(([key, icon, label]) => (
            <button key={key} aria-pressed={tab === key} onClick={() => setTab(key as typeof tab)}>
              <ClassIcon name={icon as 'apps'} />
              {t(label)}
            </button>
          ))}
        </div>
      </section>
      <section
        className="teaching-media"
        data-layout-panel="media"
        aria-label={t('classroomGallery')}
      >
        <div className="classroom-panel-heading">
          <span>{t('classroomGallery')}</span>
          {panelLayout.controls('media')}
        </div>
        {panelLayout.separator('media')}
        {media ? (
          <>
            <Suspense fallback={<ClassroomLoading overlay onLeave={() => setMedia(null)} />}>
              <Media
                moderatorIds={moderatorIds}
                controlsTarget={controlsTarget}
                onScreenShareChange={setScreenSharing}
                onSpeakersChange={updateSpeakers}
                onParticipantMediaChange={updateParticipantMedia}
                galleryTarget={tab === 'gallery' ? galleryTarget : null}
                token={media.token}
                url={media.url}
                refreshJoin={() =>
                  request<{ token: string; url: string; policy: AudioPolicy }>(base + '/join', {})
                }
                onLeave={() => setMedia(null)}
                onError={(e) => setError(e.message)}
                initialIntent={intent.current}
                onIntentChange={(value) => {
                  intent.current = value;
                }}
                onUserDisconnect={() => {
                  hadMedia.current = false;
                }}
              />
            </Suspense>
          </>
        ) : (
          <div className="media-idle-list">
            {(state.participants ?? []).slice(0, 12).map((person) => (
              <div className="media-idle-tile" key={person.id}>
                <span
                  className="media-initials"
                  style={participantAvatarStyle(person.id, person.role !== 'student')}
                >
                  {person.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join('')}
                </span>
                <strong>{person.name}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
      <main className="classroom-stage" data-layout-panel="stage">
        <div className="classroom-panel-heading">
          <span>{t('classroomStage')}</span>
          {panelLayout.controls('stage')}
        </div>
        <nav className="shared-workspace-bar" aria-label={t('sharedWorkspace')}>
          <span className="shared-workspace-label">
            <ClassIcon name="presenter" />
            {t('sharedDisplay')}
          </span>
          <div className="shared-workspace-modes">
            <button
              disabled={!canPresent || shared.busy || !docId}
              aria-pressed={shared.workspace?.kind === 'document'}
              onClick={() => void openShared('document')}
            >
              <ClassIcon name="board" />
              <span>{t('board')}</span>
            </button>
            {options.geoEnabled && (
              <button
                disabled={!canPresent || shared.busy}
                aria-pressed={shared.workspace?.kind === 'geogebra'}
                onClick={() => void openShared('geogebra')}
              >
                <ClassIcon name="shape" />
                <span>GeoGebra</span>
              </button>
            )}
            <button
              disabled={!canPresent || shared.busy}
              aria-pressed={shared.workspace?.kind === 'sandbox'}
              onClick={() => void openShared('sandbox')}
            >
              <ClassIcon name="board" />
              <span>{t('sandboxTab')}</span>
            </button>
            {presentations?.enabled && (
              <button
                disabled={!canPresent || shared.busy}
                aria-pressed={shared.workspace?.kind === 'presentation'}
                onClick={() => void openShared('presentation')}
              >
                <ClassIcon name="slides" />
                <span>{t('presentations')}</span>
              </button>
            )}
          </div>
          {manager && options.pdfImportEnabled && (
            <BoardPdfImport
              roomId={room.id}
              appendTo={bookId}
              ontoPage={
                activeDoc?.kind === 'board' &&
                activeDoc.board_format === 'excalidraw' &&
                bookId &&
                !activeDoc.background_file_id
                  ? activeDoc.id
                  : undefined
              }
              onImported={async (id) => {
                await openShared('document', id);
                await refresh();
              }}
            />
          )}
          {shared.error && <span role="alert">{shared.error}</span>}
        </nav>
        {(state.pinnedNotice || state.externalMediaUrl) && (
          <div
            className="classroom-pinned-banner"
            role="region"
            aria-label={t('pinnedNoticeLabel')}
          >
            {state.pinnedNotice && (
              <div className="pinned-notice-text">
                <strong>{t('pinnedNoticeLabel')}:</strong> <span>{state.pinnedNotice}</span>
              </div>
            )}
            {state.externalMediaUrl && (
              <a
                href={state.externalMediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="external-media-chip"
              >
                <ClassIcon name="video" size={14} /> {t('openExternalMediaLink')}
              </a>
            )}
          </div>
        )}
        {geogebraOpened && options.geoEnabled && (
          <div className="geogebra-stage" hidden={tab !== 'geogebra'}>
            <Suspense fallback={<p role="status">{t('geoLoading')}</p>}>
              <GeoGebraWorkspace
                roomId={room.id}
                userId={state.userId}
                manager={manager}
                canEdit={myPermissions.canWhiteboard}
                selectedId={shared.workspace?.geogebraId ?? null}
                perspective={shared.workspace?.geoPerspective ?? '1'}
                onPerspective={async (value) => {
                  try {
                    await shared.select({
                      kind: 'geogebra',
                      geogebraId: shared.workspace?.geogebraId ?? null,
                      geoPerspective: value,
                    });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                canSelect={canPresent}
                onSelect={async (id) => {
                  await openShared('geogebra', undefined, id);
                }}
              />
            </Suspense>
          </div>
        )}
        {sandboxOpened && (
          <div className="sandbox-stage" hidden={tab !== 'sandbox'}>
            <Suspense fallback={<p role="status">{t('sandboxLoading')}</p>}>
              <SandboxWorkspace
                roomId={room.id}
                selectedId={shared.workspace?.sandboxId ?? null}
                canSelect={canPresent}
                onSelect={async (id) => {
                  await openShared('sandbox', undefined, undefined, id);
                }}
              />
            </Suspense>
          </div>
        )}
        {tab === 'geogebra' || tab === 'sandbox' ? null : tab === 'gallery' ? (
          <div className="classroom-gallery-target" ref={setGalleryTarget}>
            {!media && (
              <div className="media-gallery-tiles">
                {(state.participants ?? []).map((person) => (
                  <div className="media-idle-tile" key={person.id}>
                    <span
                      className="media-initials"
                      style={participantAvatarStyle(person.id, person.role !== 'student')}
                    >
                      {person.name
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join('')}
                    </span>
                    <strong>{person.name}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === 'files' ? (
          <Suspense fallback={<p role="status">{t('loading')}</p>}>
            <Files
              resource="classrooms"
              id={room.id}
              onPresentFile={
                presentations?.enabled
                  ? async (fileId) => {
                      setBusy(true);
                      setError('');
                      try {
                        await request(base + '/presentations', { fileId });
                        await openShared('presentation');
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }
                  : undefined
              }
            />
          </Suspense>
        ) : tab === 'presentations' ? (
          <Suspense fallback={<p role="status">{t('loading')}</p>}>
            <Presentations
              key={room.id}
              roomId={room.id}
              state={presentations}
              sessionActive={!!state?.session}
              refresh={refresh}
            />
          </Suspense>
        ) : tab === 'breakouts' ? (
          <Breakouts room={room} onNavigate={move} />
        ) : tab === 'participants' ? (
          <MediaModeration roomId={room.id} manager={manager} userId={state?.userId ?? ''} />
        ) : tab === 'activities' ? (
          <>
            {state?.session && (
              <div className="teaching-grid">
                <section className="tool-card">
                  <h2>{t('handQueue')}</h2>
                  <ol>
                    {state.hands.map((h) => (
                      <li key={h.user_id}>
                        <span>{h.name}</span>
                        {manager && (
                          <div className="hand-queue-actions">
                            <button
                              type="button"
                              className="btn-grant-speech-inline"
                              disabled={busy}
                              onClick={() =>
                                void patchIndividualUser(h.user_id, {
                                  canMicrophone: true,
                                  lowerHand: true,
                                })
                              }
                            >
                              <ClassIcon name="mic" size={12} />
                              <span>{t('grantSpeech')}</span>
                            </button>
                            <button
                              aria-label={t('lowerHand') + ' ' + h.name}
                              disabled={busy}
                              onClick={() =>
                                void action('/hand', { raised: false, userId: h.user_id })
                              }
                            >
                              {t('lowerHand')}
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                  {!state.hands.length && <p>{t('noHands')}</p>}
                </section>
                <section className="tool-card">
                  <h2>{t('timer')}</h2>
                  <output className="timer-display" aria-label={t('timer')}>
                    {new Intl.NumberFormat(i18n.language, {
                      minimumIntegerDigits: 2,
                      useGrouping: false,
                    }).format(Math.floor(remaining / 60000))}
                    :
                    {new Intl.NumberFormat(i18n.language, {
                      minimumIntegerDigits: 2,
                      useGrouping: false,
                    }).format(Math.floor((remaining % 60000) / 1000))}
                  </output>
                  {manager && (
                    <>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action('/timer', {
                            action: 'start',
                            durationSeconds: Number(new FormData(e.currentTarget).get('seconds')),
                          });
                        }}
                      >
                        <label>
                          {t('durationSeconds')}
                          <input
                            name="seconds"
                            type="number"
                            required
                            min={1}
                            max={86400}
                            defaultValue={300}
                          />
                        </label>
                        <button disabled={busy}>{t('startTimer')}</button>
                      </form>
                      {timer && (
                        <div className="actions">
                          <button
                            disabled={busy || timer.status === 'stopped' || remaining === 0}
                            onClick={() =>
                              void action('/timer', {
                                action: timer.status === 'running' ? 'pause' : 'resume',
                              })
                            }
                          >
                            {t(timer.status === 'running' ? 'pause' : 'resume')}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void action('/timer', { action: 'reset' })}
                          >
                            {t('reset')}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
                <section className="tool-card polls">
                  <h2>{t('polls')}</h2>
                  {manager && (
                    <>
                      <div className="quick-poll-bar">
                        <span>{t('quickPollsLabel')}:</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action('/polls', {
                              question: t('quickPollYesNoQ'),
                              options: [t('yesOption'), t('noOption')],
                            })
                          }
                        >
                          {t('quickPollYesNoBtn')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action('/polls', {
                              question: t('quickPollAgreeQ'),
                              options: [t('statusAgree'), t('statusDisagree'), t('abstainOption')],
                            })
                          }
                        >
                          {t('quickPollAgreeBtn')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action('/polls', {
                              question: t('quickPollAbcdQ'),
                              options: ['A / الف', 'B / ب', 'C / ج', 'D / د'],
                            })
                          }
                        >
                          A / B / C / D
                        </button>
                      </div>
                      <form
                        className="poll-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void action('/polls', {
                            question: f.get('question'),
                            options: String(f.get('options'))
                              .split('\n')
                              .map((s) => s.trim())
                              .filter(Boolean),
                            ...(f.get('duration')
                              ? { durationSeconds: Number(f.get('duration')) }
                              : {}),
                          });
                        }}
                      >
                        <label>
                          {t('question')}
                          <input name="question" required maxLength={500} />
                        </label>
                        <label>
                          {t('pollOptions')}
                          <textarea name="options" required rows={3} maxLength={2400} />
                        </label>
                        <label>
                          {t('optionalDeadline')}
                          <input name="duration" type="number" min={10} max={86400} />
                        </label>
                        <button className="primary" disabled={busy}>
                          {t('launchPoll')}
                        </button>
                      </form>
                    </>
                  )}
                  {state.polls.map((p) => (
                    <article className="poll" key={p.id}>
                      <span className="eyebrow">
                        {t(p.status as 'open')} · {p.responseCount} {t('responses')}
                      </span>
                      <h3>{p.question}</h3>
                      <div className="poll-options">
                        {p.options.map((o, index) => (
                          <button
                            key={index}
                            disabled={busy || p.status !== 'open' || p.myChoice !== null}
                            aria-pressed={p.myChoice === index}
                            onClick={() =>
                              void action('/polls/' + p.id + '/vote', { choice: index })
                            }
                          >
                            {o}
                            {p.counts && <span>{p.counts[index]}</span>}
                          </button>
                        ))}
                      </div>
                      {manager && (
                        <div className="actions">
                          {p.status !== 'ended' && (
                            <>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void action('/polls/' + p.id + '/control', {
                                    action: p.status === 'paused' ? 'resume' : 'pause',
                                  })
                                }
                              >
                                {t(p.status === 'paused' ? 'resume' : 'pause')}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void action('/polls/' + p.id + '/control', { action: 'end' })
                                }
                              >
                                {t('endPoll')}
                              </button>
                            </>
                          )}
                          <button
                            disabled={busy || p.results_published}
                            onClick={() =>
                              void action('/polls/' + p.id + '/control', { action: 'publish' })
                            }
                          >
                            {t('publishResults')}
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              </div>
            )}
          </>
        ) : tab === 'attendance' ? (
          <section className="tool-card">
            <div className="section-heading">
              <h2>{t('attendance')}</h2>
              <button onClick={exportAttendance} disabled={!attendance?.participants.length}>
                {t('exportCsv')}
              </button>
            </div>
            <p>{t('attendanceHelp')}</p>
            {attendance ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('name')}</th>
                      <th>{t('attendanceDuration')}</th>
                      <th>{t('connections')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.participants.map((p) => (
                      <tr key={p.userId}>
                        <td>{p.name}</td>
                        <td>
                          {new Intl.NumberFormat(i18n.language, {
                            maximumFractionDigits: 1,
                          }).format(p.totalDurationMs / 60000)}{' '}
                          {t('minutes')}
                        </td>
                        <td>{new Intl.NumberFormat(i18n.language).format(p.connections.length)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!attendance.participants.length && <p>{t('noAttendance')}</p>}
              </div>
            ) : (
              <p role="status">{t('loading')}</p>
            )}
          </section>
        ) : (
          <div className="document-layout">
            <div className="classroom-document-bar">
              <div className="document-list">
                {docs
                  .filter((d) => !d.board_book_id)
                  .map((d) => (
                    <button
                      aria-pressed={docId === d.id || bookId === d.id}
                      title={d.name}
                      key={d.id}
                      disabled={
                        (canPresent && shared.busy) ||
                        (!canPresent &&
                          (shared.workspace?.kind !== 'document' ||
                            shared.workspace.documentId !== d.id))
                      }
                      onClick={() => selectVisibleDocument(d.id)}
                    >
                      <ClassIcon name={d.kind === 'notes' ? 'notes' : 'board'} />
                      <span>{d.name}</span>
                    </button>
                  ))}
              </div>
              {manager && (
                <button
                  aria-label={t('classManageContent')}
                  title={t('classManageContent')}
                  onClick={() => setManageDocuments(true)}
                >
                  <ClassIcon name="plus" />
                </button>
              )}
            </div>
            <dialog
              ref={documentDialog}
              className="classroom-dialog"
              onClose={() => setManageDocuments(false)}
            >
              <header>
                <h2>{t('classManageContent')}</h2>
                <button aria-label={t('classClosePanel')} onClick={() => setManageDocuments(false)}>
                  <ClassIcon name="close" />
                </button>
              </header>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              {manager && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void createDocument({
                      name: f.get('name'),
                      kind: f.get('kind'),
                      boardFormat: f.get('kind') === 'board' ? f.get('boardFormat') : 'legacy',
                      teacherOnly: f.get('teacherOnly') === 'on',
                    });
                  }}
                >
                  <label>
                    {t('name')}
                    <input name="name" required maxLength={120} />
                  </label>
                  <label>
                    {t('documentType')}
                    <select name="kind">
                      <option value="notes">{t('notes')}</option>
                      <option value="board">{t('board')}</option>
                    </select>
                  </label>
                  <label>
                    {t('boardEditor')}
                    <select name="boardFormat" defaultValue="excalidraw">
                      <option value="excalidraw">{t('advancedBoard')}</option>
                      <option value="legacy">{t('basicBoard')}</option>
                    </select>
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" name="teacherOnly" />
                    {t('teacherOnly')}
                  </label>
                  <button disabled={busy}>{t('create')}</button>
                </form>
              )}
            </dialog>
            {activeDoc?.board_format === 'excalidraw' && (
              <nav className="board-page-bar" aria-label={t('boardPages')}>
                <AnnotationPageManager
                  roomId={room.id}
                  pages={docs.filter((d) => d.id === bookId || d.board_book_id === bookId)}
                  selectedId={docId}
                  canManage={canPresent && myPermissions.canWhiteboard}
                  onBeforeChange={async () => {
                    await boardSync.current?.();
                  }}
                  onChange={refresh}
                  onSelect={(id) => openShared('document', id)}
                />
                <button
                  aria-label={t('boardPreviousPage')}
                  disabled={!canPresent || shared.busy || pageIndex <= 0}
                  onClick={() => void openShared('document', boardPages[pageIndex - 1].id)}
                >
                  ‹
                </button>
                <label>
                  <span className="sr-only">{t('boardPages')}</span>
                  <select
                    aria-label={t('boardPages')}
                    value={docId}
                    disabled={!canPresent || shared.busy}
                    onChange={(e) => void openShared('document', e.target.value)}
                  >
                    {boardPages.map((d, index) => (
                      <option key={d.id} value={d.id}>
                        {t('boardPageNumber', { number: index + 1 })}
                      </option>
                    ))}
                  </select>
                </label>
                <span>{t('boardPageTotal', { count: boardPages.length })}</span>
                <button
                  aria-label={t('boardNextPage')}
                  disabled={!canPresent || shared.busy || pageIndex >= boardPages.length - 1}
                  onClick={() => void openShared('document', boardPages[pageIndex + 1].id)}
                >
                  ›
                </button>
                {canPresent && (
                  <button
                    disabled={busy || boardPages.length >= 100}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        const result = await request<{ id: string }>(
                          base + '/documents/' + docId + '/pages',
                          {},
                        );
                        await openShared('document', result.id);
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <ClassIcon name="plus" />
                    <span>{t('boardAddPage')}</span>
                  </button>
                )}
              </nav>
            )}
            {activeDoc?.board_format === 'excalidraw' ? (
              <Suspense fallback={<p role="status">{t('loading')}</p>}>
                <AdvancedBoard
                  key={activeDoc.id}
                  roomId={room.id}
                  document={activeDoc}
                  pages={boardPages}
                  userId={state?.userId ?? ''}
                  manager={manager}
                  onSynchronize={(fn) => {
                    boardSync.current = fn;
                  }}
                  canPresent={canPresent}
                />
              </Suspense>
            ) : activeDoc ? (
              <CollaborativeDocument
                key={activeDoc.id}
                roomId={room.id}
                document={activeDoc}
                userId={state?.userId ?? ''}
                readOnly={
                  myPermissions.interactionLocked ||
                  (activeDoc.kind === 'notes' && !myPermissions.canSharedNotes) ||
                  (activeDoc.kind === 'board' &&
                    !manager &&
                    !myPermissions.isPresenter &&
                    (!myPermissions.canWhiteboard ||
                      (activeDoc.teacher_only &&
                        myPermissions.overrides?.canWhiteboard !== true))) ||
                  (activeDoc.kind === 'notes' && activeDoc.teacher_only && !manager)
                }
              />
            ) : (
              <section className="empty">
                <h2>
                  {t(
                    docs.length
                      ? 'selectDocument'
                      : manager
                        ? 'startClassContent'
                        : 'waitingClassContent',
                  )}
                </h2>
                {manager && !docs.length ? (
                  <div className="classroom-quick-content">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void createDocument({
                          name: t('board'),
                          kind: 'board',
                          boardFormat: 'excalidraw',
                          teacherOnly: false,
                        })
                      }
                    >
                      <ClassIcon name="board" />
                      {t('newClassBoard')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void createDocument({
                          name: t('notes'),
                          kind: 'notes',
                          boardFormat: 'legacy',
                          teacherOnly: false,
                        })
                      }
                    >
                      <ClassIcon name="notes" />
                      {t('newClassNotes')}
                    </button>
                  </div>
                ) : docs.length ? (
                  <p>{t('documentHelp')}</p>
                ) : null}
              </section>
            )}
          </div>
        )}
      </main>
      <footer className="classroom-actions">
        <div className="classroom-actions-start">
          <button
            className="classroom-round"
            aria-label={t('classApps')}
            aria-pressed={sidePanel === 'apps'}
            title={t('classApps')}
            onClick={toggleAppsPanel}
          >
            <ClassIcon name="plus" />
          </button>
        </div>
        <div className="classroom-call-controls" ref={setControlsTarget}>
          {!media && (
            <button
              className="classroom-round join-audio"
              title={t('connectMedia')}
              disabled={busy || !state.session}
              onClick={async () => {
                if (media) {
                  hadMedia.current = false;
                  setMedia(null);
                  return;
                }
                setBusy(true);
                setJoining(true);
                setAudioOffer(undefined);
                setAudioDialogOpen(true);
                const version = ++joinVersion.current,
                  controller = new AbortController();
                joinAbort.current = controller;
                setError('');
                try {
                  const joined = await request<{ token: string; url: string; policy: AudioPolicy }>(
                    base + '/join',
                    {},
                    { signal: controller.signal },
                  );
                  if (version === joinVersion.current) {
                    setAudioOffer(joined);
                  }
                } catch (e) {
                  if (version === joinVersion.current && (e as Error).name !== 'AbortError')
                    setError((e as Error).message);
                } finally {
                  if (version === joinVersion.current) {
                    setBusy(false);
                    setJoining(false);
                  }
                }
              }}
            >
              <ClassIcon name="audio" />
              <span>{t(joining ? 'connection_connecting' : 'connectMedia')}</span>
            </button>
          )}
          {joining && !audioDialogOpen && <button onClick={cancelJoin}>{t('cancel')}</button>}
        </div>
        <div className="classroom-actions-end">
          <button
            className="classroom-round"
            disabled={
              !state.session ||
              busy ||
              (!manager &&
                !myPermissions.canRaiseHand &&
                !state.hands.some((hand) => hand.user_id === state.userId))
            }
            aria-label={t(
              state.hands.some((hand) => hand.user_id === state.userId) ? 'lowerHand' : 'raiseHand',
            )}
            aria-pressed={state.hands.some((hand) => hand.user_id === state.userId)}
            title={!manager && !myPermissions.canRaiseHand ? t('permHandDisabled') : t('raiseHand')}
            onClick={() =>
              void action('/hand', {
                raised: !state.hands.some((hand) => hand.user_id === state.userId),
              })
            }
          >
            <ClassIcon name="hand" />
          </button>
          <button
            className="classroom-round classroom-leave"
            aria-label={t('back')}
            title={t('back')}
            onClick={onLeave}
          >
            <ClassIcon name="leave" />
          </button>
        </div>
      </footer>
    </div>
  );
}

export { Teaching };
