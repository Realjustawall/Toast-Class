import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ClassIcon from './classroom-icons';
import { useClassroomConnection } from './live';
import { FormattedText } from './formatted-text';
import RichTextEditor from './rich-text-editor';
import { playClassroomSound } from './classroom-sounds';
import { participantAvatarStyle } from './participant-identity';
import ChatCategories, { type ChatCategory } from './chat-categories';
import ChatImage from './chat-image';
import { usePlatformOptions } from './platform-options';
import { readJsonResponse, ResponseError } from './http-response';
import { useChatPolicy, ChatPolicyControls } from './chat-policy';

type Message = {
  id: string;
  body: string;
  name: string;
  user_id?: string;
  role?: string;
  created_at: string;
  category_id?: string | null;
  image_file_id?: string | null;
};

export default function Chat({
  roomId,
  canWrite = false,
  chatEnabled = true,
  userId,
  moderatorIds = [],
  canSendImages = false,
}: {
  roomId: string;
  canWrite?: boolean;
  chatEnabled?: boolean;
  userId?: string;
  moderatorIds?: string[];
  canSendImages?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { options } = usePlatformOptions();
  const chatPolicy = useChatPolicy(roomId),
    [privateMode, setPrivateMode] = useState(false),
    [peerId, setPeerId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatTab, setChatTab] = useState('public');
  const threadCategory = privateMode ? 'private:' + peerId : chatTab;
  const messageBase =
    '/classrooms/' + roomId + (privateMode ? '/private-chats/' + peerId : '/messages');
  const messagesPath = privateMode ? messageBase + '/messages' : messageBase;
  useEffect(() => {
    if (peerId && chatPolicy.data && !chatPolicy.data.participants.some((p) => p.id === peerId))
      setPeerId('');
  }, [chatPolicy.data?.participants, peerId]);
  const [categories, setCategories] = useState<ChatCategory[]>([]);
  const [manageCategories, setManageCategories] = useState(false);
  const categoryVersion = useRef(0),
    categoryTabs = useRef<HTMLDivElement>(null);
  const activeTab = useRef(chatTab);
  activeTab.current = threadCategory;
  const draftKey = (category = chatTab) =>
    'chat-draft:' +
    userId +
    ':' +
    roomId +
    (privateMode ? ':private:' + peerId : category === 'public' ? '' : ':' + category);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [retryUntil, setRetryUntil] = useState(0),
    [retryNow, setRetryNow] = useState(Date.now()),
    [uploadLimited, setUploadLimited] = useState(false);
  const operationActive = useRef(false),
    operationAbort = useRef(new AbortController());
  const beginOperation = () => {
    if (operationActive.current) return false;
    operationActive.current = true;
    setBusy(true);
    setError('');
    return true;
  };
  const endOperation = () => {
    operationActive.current = false;
    setBusy(false);
  };
  const retrySeconds = Math.max(0, Math.ceil((retryUntil - retryNow) / 1000));
  useEffect(() => {
    if (!retryUntil) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      setRetryNow(now);
      if (now < retryUntil) timer = setTimeout(tick, 250);
      else setRetryUntil(0);
    };
    tick();
    return () => clearTimeout(timer);
  }, [retryUntil]);
  useEffect(() => {
    const controller = new AbortController();
    operationAbort.current = controller;
    return () => controller.abort();
  }, []);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editBody, setEditBody] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [unread, setUnread] = useState(0);
  const version = useRef(0);
  const messageList = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [draft, setDraft] = useState('');
  const drafts = useRef(new Map<string, string>());
  type Attachment = { file: File; uploadedId?: string; ready?: boolean };
  const attachments = useRef(new Map<string, Attachment>()),
    imageInput = useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null),
    [previewUrl, setPreviewUrl] = useState('');
  useEffect(() => {
    if (!attachment) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);
  const composerForm = useRef<HTMLFormElement>(null);
  type SendAttempt = { id: string; body: string; imageFileId?: string };
  const sendAttempts = useRef(new Map<string, SendAttempt>()),
    restoredAttempts = useRef(new Set<string>());
  const seen = useRef<Set<string> | undefined>(undefined);
  const readJob = useRef<Promise<void> | undefined>(undefined),
    readAbort = useRef<AbortController | undefined>(undefined),
    readAgain = useRef(false),
    readNotBefore = useRef(0),
    readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    loadLatest = useRef<() => Promise<void>>(async () => {});
  const scheduleRead = (delay: number) => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => void loadLatest.current(), Math.max(0, delay));
  };

  async function load() {
    if (privateMode && !peerId) return;
    if (readJob.current) {
      readAgain.current = true;
      return readJob.current;
    }
    if (Date.now() < readNotBefore.current) {
      scheduleRead(readNotBefore.current - Date.now());
      return;
    }
    const current = ++version.current;
    const controller = new AbortController();
    readAbort.current = controller;
    readAgain.current = false;
    const job = (async () => {
      try {
        const result = await request<Message[]>(
          messagesPath + (privateMode ? '' : '?categoryId=' + encodeURIComponent(chatTab)),
          undefined,
          {
            silent: true,
            signal: controller.signal,
          },
        );
        if (current !== version.current) return;
        if (seen.current && !follow.current)
          setUnread(
            (value) =>
              value +
              result.filter(
                (message) => !seen.current!.has(message.id) && message.user_id !== userId,
              ).length,
          );
        if (
          seen.current &&
          result.some((message) => !seen.current!.has(message.id) && message.user_id !== userId)
        )
          playClassroomSound('message');
        seen.current = new Set(result.map((message) => message.id));
        setMessages(result);
        setSyncError('');
      } catch (e) {
        if (current !== version.current || controller.signal.aborted) return;
        if (e instanceof ResponseError && e.status === 429) {
          readNotBefore.current = Date.now() + e.retryAfterMs;
          readAgain.current = true;
          setSyncError(t('chatSyncWaiting'));
        } else setSyncError((e as Error).message);
      } finally {
        if (readAbort.current === controller) {
          readJob.current = undefined;
          readNotBefore.current = Math.max(readNotBefore.current, Date.now() + 250);
          if (readAgain.current) scheduleRead(readNotBefore.current - Date.now());
        }
      }
    })();
    readJob.current = job;
    await job;
  }
  loadLatest.current = load;

  async function loadCategories() {
    const current = ++categoryVersion.current;
    try {
      const next = await request<ChatCategory[]>(
        '/classrooms/' + roomId + '/chat-categories',
        undefined,
        { silent: true },
      );
      if (current !== categoryVersion.current) return;
      setCategories(next);
      setChatTab((selected) =>
        selected === 'public' || next.some((category) => category.id === selected)
          ? selected
          : 'public',
      );
    } catch (e) {
      if (current === categoryVersion.current) setSyncError((e as Error).message);
    }
  }
  const connection = useClassroomConnection(roomId, () => void load(), [
    privateMode ? 'private_chat_changed' : 'chat_changed',
  ]);
  useClassroomConnection(roomId, () => void loadCategories(), ['chat_categories_changed'], false);

  useEffect(() => {
    setChatTab('public');
    setCategories([]);
    setManageCategories(false);
    void loadCategories();
    return () => {
      categoryVersion.current++;
    };
  }, [roomId]);

  useEffect(() => {
    seen.current = undefined;
    setMessages([]);
    setEditing(null);
    setConfirmClear(false);
    setUnread(0);
    setAttachment(attachments.current.get(threadCategory) ?? null);
    follow.current = true;
    try {
      const savedSize = Number(localStorage.getItem('classroom-chat-font-size'));
      if ([12, 14, 16, 18, 20].includes(savedSize)) setFontSize(savedSize);
    } catch {}
    let savedDraft = drafts.current.get(threadCategory);
    if (savedDraft === undefined) {
      try {
        savedDraft = sessionStorage.getItem(draftKey()) ?? '';
      } catch {
        savedDraft = '';
      }
    }
    drafts.current.set(threadCategory, savedDraft);
    setDraft(savedDraft);
    void load();
    return () => {
      version.current++;
      readAbort.current?.abort();
      readAbort.current = undefined;
      readJob.current = undefined;
      readAgain.current = false;
      readNotBefore.current = 0;
      clearTimeout(readTimer.current);
    };
  }, [roomId, chatTab, privateMode, peerId]);

  useEffect(() => {
    categoryTabs.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [chatTab, categories]);

  useEffect(() => {
    if (follow.current && messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
    const list = messageList.current;
    if (!list) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) list.scrollTop = list.scrollHeight;
      });
    });
    for (const article of list.querySelectorAll('article')) observer.observe(article);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [messages]);

  const studentLocked = privateMode
    ? !peerId || !chatPolicy.data?.canSendPrivate
    : (!chatEnabled && !canWrite) || chatPolicy.data?.publicEnabled === false;
  const modSet = new Set(moderatorIds);

  const tabs = [{ id: 'public', name: t('chatPublic') }, ...categories];

  return (
    <aside className="chat" data-scope={privateMode ? 'private' : 'public'}>
      <div className="chat-scope-bar">
        <button
          type="button"
          aria-pressed={!privateMode}
          disabled={busy}
          onClick={() => setPrivateMode(false)}
        >
          {t('chatPublicMode')}
        </button>
        <button
          type="button"
          aria-pressed={privateMode}
          disabled={busy}
          onClick={() => setPrivateMode(true)}
        >
          {t('chatPrivateMode')}
          {!!chatPolicy.data?.unread.length && (
            <span className="chat-private-unread">
              {chatPolicy.data.unread.reduce((n, p) => n + p.count, 0)}
            </span>
          )}
        </button>
        <ChatPolicyControls policy={chatPolicy} />
      </div>
      {privateMode && (
        <label className="chat-private-peer">
          <span className="sr-only">{t('chatChooseParticipant')}</span>
          <select
            aria-label={t('chatChooseParticipant')}
            value={peerId}
            disabled={busy}
            onChange={(event) => setPeerId(event.target.value)}
          >
            <option value="">{t('chatChooseParticipant')}</option>
            {chatPolicy.data?.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {chatPolicy.data!.unread.some((u) => u.userId === p.id)
                  ? ' (' + chatPolicy.data!.unread.find((u) => u.userId === p.id)!.count + ')'
                  : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="chat-title-row">
        <h2>{t('chat')}</h2>
        <div
          className="chat-filter-tabs"
          role="tablist"
          aria-label={t('chatCategories')}
          ref={categoryTabs}
          onKeyDown={(event) => {
            if (busy) return;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex((category) => category.id === chatTab);
            const direction =
              (event.key === 'ArrowRight' ? 1 : -1) * (i18n.dir() === 'rtl' ? -1 : 1);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + direction + tabs.length) % tabs.length;
            setChatTab(tabs[next].id);
            categoryTabs.current
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          {!privateMode &&
            tabs.map((category) => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={chatTab === category.id}
                tabIndex={chatTab === category.id ? 0 : -1}
                disabled={busy}
                title={category.name}
                className={'chat-filter-tab' + (chatTab === category.id ? ' is-active' : '')}
                onClick={() => setChatTab(category.id)}
              >
                {category.name}
              </button>
            ))}
        </div>
        {canWrite && !privateMode && (
          <button
            type="button"
            className="quiet chat-category-manage"
            aria-label={t('chatManageCategories')}
            title={t('chatManageCategories')}
            onClick={() => setManageCategories(true)}
          >
            <ClassIcon name="plus" />
          </button>
        )}
        <label className="chat-font-size">
          <span className="sr-only">{t('chatFontSize')}</span>
          <select
            title={t('chatFontSize')}
            value={fontSize}
            onChange={(e) => {
              setFontSize(Number(e.target.value));
              try {
                localStorage.setItem('classroom-chat-font-size', e.target.value);
              } catch {}
            }}
          >
            {[12, 14, 16, 18, 20].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        {canWrite && !privateMode && messages.length > 0 && (
          <button
            type="button"
            className="quiet chat-clear-btn"
            aria-label={t(confirmClear ? 'chatConfirmClear' : 'chatClearBtn')}
            title={t(confirmClear ? 'chatConfirmClear' : 'chatClearBtn')}
            disabled={busy}
            onClick={() => setConfirmClear(true)}
          >
            <ClassIcon name="trash" />
            <span className="sr-only">{t(confirmClear ? 'chatConfirmClear' : 'chatClearBtn')}</span>
          </button>
        )}
      </div>
      {confirmClear && (
        <div className="chat-clear-confirm" role="group" aria-label={t('chatConfirmClear')}>
          <span>{t('chatConfirmClear')}</span>
          <div className="chat-clear-confirm-actions">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setConfirmClear(false)}
            >
              {t('chatCancel')}
            </button>
            <button
              type="button"
              className="chat-clear-confirm-action"
              disabled={busy}
              onClick={() => {
                if (!beginOperation()) return;
                void (async () => {
                  try {
                    await request(messagesPath + '/clear', {});
                    await load();
                    setConfirmClear(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    endOperation();
                  }
                })();
              }}
            >
              {t('chatConfirmClearAction')}
            </button>
          </div>
        </div>
      )}
      <small role="status">
        {t(connection === 'connected' ? 'liveConnected' : 'connection_' + connection)}
      </small>
      {studentLocked && (!privateMode || !!peerId) && (
        <div className="chat-policy-banner" role="note">
          <ClassIcon name="lock" />
          <span>
            {t(
              privateMode
                ? 'chatPrivateDisabled'
                : chatPolicy.data?.publicEnabled === false
                  ? 'chatPublicDisabled'
                  : 'permChatDisabledNotice',
            )}
          </span>
        </div>
      )}
      <div
        className="messages"
        role="log"
        aria-label={t('chat')}
        aria-live="polite"
        aria-relevant="additions text"
        style={{ fontSize }}
        ref={messageList}
        onScroll={(event) => {
          const list = event.currentTarget;
          follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
          if (follow.current) setUnread(0);
        }}
      >
        {messages.map((m) => {
          const isOwn = m.user_id === userId;
          const isMod =
            m.role === 'owner' ||
            m.role === 'teacher' ||
            (!m.role && Boolean(m.user_id && modSet.has(m.user_id)));
          return (
            <article
              key={m.id}
              className={[isOwn ? 'is-own' : '', isMod ? 'is-mod' : ''].filter(Boolean).join(' ')}
            >
              <span
                className="message-avatar"
                data-user-id={m.user_id}
                data-role={isMod ? 'moderator' : 'viewer'}
                style={participantAvatarStyle(m.user_id ?? m.name, isMod)}
                aria-hidden="true"
              >
                {m.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')}
              </span>
              <strong title={m.name}>{m.name}</strong>{' '}
              <time>
                {new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(
                  new Date(m.created_at),
                )}
              </time>
              {editing?.id === m.id ? (
                <form
                  className="chat-edit-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy || (!editBody.trim() && !m.image_file_id)) return;
                    if (!beginOperation()) return;
                    try {
                      await request(messagesPath + '/' + m.id + '/edit', {
                        body: editBody,
                        expectedBody: editing.body,
                      });
                      setEditing(null);
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      endOperation();
                    }
                  }}
                >
                  <RichTextEditor
                    compact
                    value={editBody}
                    onChange={setEditBody}
                    label={t('chatEdit')}
                    maxLength={options.chatMessageMaxLength}
                  />
                  <button disabled={busy}>{t('chatSave')}</button>
                  <button type="button" className="quiet" onClick={() => setEditing(null)}>
                    {t('chatCancel')}
                  </button>
                </form>
              ) : m.body ? (
                <FormattedText text={m.body} />
              ) : null}
              {m.image_file_id && <ChatImage roomId={roomId} fileId={m.image_file_id} />}
              {(isOwn || (canWrite && !privateMode)) && (
                <div className="chat-message-actions">
                  <button
                    type="button"
                    className="quiet"
                    aria-label={t('chatEdit')}
                    title={t('chatEdit')}
                    disabled={busy || studentLocked}
                    onClick={() => {
                      setEditing(m);
                      setEditBody(m.body);
                    }}
                  >
                    <ClassIcon name="pen" />
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    aria-label={t('chatDelete')}
                    title={t('chatDelete')}
                    disabled={busy}
                    onClick={async () => {
                      if (!beginOperation()) return;
                      try {
                        await request(messagesPath + '/' + m.id + '/delete', {});
                        if (editing?.id === m.id) setEditing(null);
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        endOperation();
                      }
                    }}
                  >
                    <ClassIcon name="trash" />
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {unread > 0 && (
        <button
          className="chat-unread"
          type="button"
          onClick={() => {
            follow.current = true;
            setUnread(0);
            messageList.current?.scrollTo({
              top: messageList.current.scrollHeight,
              behavior: 'auto',
            });
          }}
        >
          {t('chatUnread', { count: unread })}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {syncError && (
        <p role="status" className="chat-sync-notice">
          {syncError}
        </p>
      )}
      {chatPolicy.error && (
        <p role="alert" className="error">
          {chatPolicy.error}
        </p>
      )}
      {retrySeconds > 0 && (
        <p role="status" className="chat-retry-notice">
          {t('chatRetryIn', { seconds: retrySeconds })}
        </p>
      )}
      <form
        className="chat-composer"
        ref={composerForm}
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            operationActive.current ||
            studentLocked ||
            (retrySeconds > 0 && (!uploadLimited || !!attachment))
          )
            return;
          const rawBody = draft.trim();
          if (!rawBody && !attachment) return;
          if (attachment && (!canSendImages || privateMode)) {
            setError(t('chatImagesDenied'));
            return;
          }
          const sourceCategory = threadCategory,
            sourceDraft = draftKey();
          if (!beginOperation()) return;
          let phase: 'upload' | 'send' = attachment ? 'upload' : 'send';
          const signal = operationAbort.current.signal;
          try {
            let imageFileId = attachment?.uploadedId;
            if (attachment && !imageFileId) {
              const form = new FormData();
              form.append('file', attachment.file);
              const response = await fetch('/api/v1/classrooms/' + roomId + '/files?chatImage=1', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'x-toaster-file-size': String(attachment.file.size) },
                body: form,
                signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
              });
              const file = await readJsonResponse<{ id: string; status: string }>(response);
              imageFileId = file.id;
              const saved = { ...attachment, uploadedId: file.id, ready: file.status === 'ready' };
              attachments.current.set(sourceCategory, saved);
              if (activeTab.current === sourceCategory) setAttachment(saved);
              if (file.status !== 'ready' && file.status !== 'quarantined')
                throw new Error(t('chatImageProcessing'));
            }
            if (imageFileId) {
              let file = await request<{ status: string }>(
                '/classrooms/' + roomId + '/files/' + imageFileId + '/status',
                undefined,
                { signal, silent: true },
              );
              const deadline = Date.now() + 60000;
              while (file.status === 'quarantined' && Date.now() < deadline) {
                await new Promise<void>((resolve, reject) => {
                  const stop = () => {
                      clearTimeout(timer);
                      reject(signal.reason);
                    },
                    timer = setTimeout(() => {
                      signal.removeEventListener('abort', stop);
                      resolve();
                    }, 500);
                  signal.addEventListener('abort', stop, { once: true });
                  if (signal.aborted) stop();
                });
                file = await request(
                  '/classrooms/' + roomId + '/files/' + imageFileId + '/status',
                  undefined,
                  { signal, silent: true },
                );
              }
              if (file.status !== 'ready') throw new Error(t('chatImageProcessing'));
            }
            phase = 'send';
            const key = sourceDraft + ':attempt';
            let attempt = sendAttempts.current.get(key);
            if (!restoredAttempts.current.has(key)) {
              restoredAttempts.current.add(key);
              try {
                attempt = JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined;
              } catch {}
            }
            if (
              !attempt ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attempt.id) ||
              attempt.body !== rawBody ||
              attempt.imageFileId !== imageFileId
            )
              attempt = {
                id: crypto.randomUUID(),
                body: rawBody,
                ...(imageFileId ? { imageFileId } : {}),
              };
            sendAttempts.current.set(key, attempt);
            try {
              sessionStorage.setItem(key, JSON.stringify(attempt));
            } catch {}
            await request(
              messagesPath,
              {
                body: rawBody,
                ...(!privateMode ? { categoryId: chatTab === 'public' ? null : chatTab } : {}),
                ...(imageFileId ? { imageFileId } : {}),
                clientMessageId: attempt.id,
              },
              { signal, silent: true },
            );
            attachments.current.delete(sourceCategory);
            sendAttempts.current.delete(key);
            const unchangedDraft = drafts.current.get(sourceCategory) === draft;
            if (unchangedDraft) drafts.current.set(sourceCategory, '');
            if (activeTab.current === sourceCategory) {
              if (unchangedDraft) setDraft('');
              setAttachment(null);
            }
            try {
              if (unchangedDraft) sessionStorage.removeItem(sourceDraft);
              sessionStorage.removeItem(key);
            } catch {}
            follow.current = true;
            await load();
          } catch (e) {
            if (signal.aborted) return;
            if (e instanceof ResponseError && e.status === 429) {
              setUploadLimited(phase === 'upload');
              setRetryNow(Date.now());
              setRetryUntil(Date.now() + e.retryAfterMs);
            }
            setError(
              e instanceof ResponseError && e.status === 429
                ? t('requestRateLimited')
                : (e as Error).message,
            );
          } finally {
            endOperation();
          }
        }}
      >
        <input
          ref={imageInput}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          style={{ display: 'none' }}
          aria-label={t('chatAttachImage')}
          disabled={privateMode || !canSendImages || busy || studentLocked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (
              file.size > options.chatImageMaxMiB * 1024 * 1024 ||
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)
            ) {
              setError(t('chatImageTypeSize', { size: options.chatImageMaxMiB }));
              return;
            }
            const next = { file };
            attachments.current.set(threadCategory, next);
            setAttachment(next);
            setError('');
          }}
        />
        {attachment && (
          <div className="chat-selected-image">
            {previewUrl && <img src={previewUrl} alt={t('chatImage')} />}
            <span title={attachment.file.name}>{attachment.file.name}</span>
            <button
              type="button"
              disabled={busy}
              aria-label={t('chatRemoveImage')}
              onClick={() => {
                attachments.current.delete(threadCategory);
                setAttachment(null);
              }}
            >
              <ClassIcon name="close" />
            </button>
          </div>
        )}
        <RichTextEditor
          compact
          toolbarActions={
            !privateMode && (
              <button
                type="button"
                title={t(canSendImages ? 'chatAttachImage' : 'chatImagesLockedHint')}
                aria-label={t('chatAttachImage')}
                disabled={!canSendImages || busy || studentLocked}
                onClick={() => imageInput.current?.click()}
              >
                <ClassIcon name="image" />
              </button>
            )
          }
          value={draft}
          label={t('message')}
          maxLength={options.chatMessageMaxLength}
          disabled={studentLocked}
          placeholder={t('messagePlaceholder')}
          onSubmit={() => composerForm.current?.requestSubmit()}
          onChange={(value) => {
            drafts.current.set(threadCategory, value);
            setDraft(value);
            setError('');
            try {
              sessionStorage.setItem(draftKey(), value);
            } catch {}
          }}
        />
        <button
          disabled={
            busy ||
            studentLocked ||
            (!draft.trim() && !attachment) ||
            (retrySeconds > 0 && (!uploadLimited || !!attachment))
          }
          aria-label={t('send')}
          title={t('send')}
        >
          <ClassIcon name="send" />
        </button>
      </form>
      {canWrite && !privateMode && manageCategories && (
        <ChatCategories
          roomId={roomId}
          categories={categories}
          onChanged={loadCategories}
          onClose={() => setManageCategories(false)}
        />
      )}
    </aside>
  );
}

export { Chat };
