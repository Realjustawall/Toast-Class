import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomEvents } from './live';
import { useClassroomDownloads, DownloadToggle } from './classroom-downloads';

type FileItem = {
  id: string;
  name: string;
  originalName: string;
  folderId: string | null;
  byteSize: number;
  mediaType: string | null;
  status: string;
  scanStatus: string;
  failureCode: string | null;
  createdAt: string;
};
type Folder = { id: string; name: string; parentId: string | null };
type State = {
  enabled: boolean;
  canUpload: boolean;
  files: FileItem[];
  folders: Folder[];
  nextCursor: string | null;
  usage: { usedBytes: string; quotaBytes: string };
  maxUploadBytes: number;
  role: string;
};
type Props = {
  resource: 'classrooms' | 'organizations';
  id: string;
  onPresentFile?: (fileId: string) => Promise<void>;
};

export default function Files(props: Props) {
  return props.resource === 'classrooms' ? (
    <ClassroomFiles key={props.id} {...props} />
  ) : (
    <FileBrowser key={props.id} {...props} revision={0} />
  );
}
function ClassroomFiles(props: Props) {
  const [revision, setRevision] = useState(0);
  useClassroomEvents(props.id, () => setRevision((v) => v + 1));
  return <FileBrowser {...props} revision={revision} />;
}

function FileBrowser({ resource, id, revision, onPresentFile }: Props & { revision: number }) {
  const { t, i18n } = useTranslation();
  const downloads = useClassroomDownloads(resource === 'classrooms' ? id : undefined);
  const base = '/' + resource + '/' + id;
  const [data, setData] = useState<State>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [editing, setEditing] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [preview, setPreview] = useState<{
    file: FileItem;
    text?: string;
    url?: string;
    loading: boolean;
  }>();
  const dialog = useRef<HTMLDialogElement>(null),
    picker = useRef<HTMLInputElement>(null),
    xhr = useRef<XMLHttpRequest | null>(null),
    fetching = useRef<AbortController | null>(null),
    previewRequest = useRef<AbortController | null>(null),
    previewUrl = useRef(''),
    active = useRef(true),
    loadRevision = useRef(0);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const cursor = cursors.at(-1);
  const manager = !!data && data.role !== 'student';
  const number = (n: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(n);
  const bytes = (n: number) =>
    n >= 1e6
      ? number(n / 1e6) + ' ' + t('fileMB')
      : n >= 1000
        ? number(n / 1000) + ' ' + t('fileKB')
        : number(n) + ' ' + t('fileBytes');
  async function load(force = false) {
    if (fetching.current && !force) return;
    fetching.current?.abort();
    const controller = new AbortController();
    fetching.current = controller;
    const version = ++loadRevision.current;
    const query = new URLSearchParams();
    if (folderId) query.set('folderId', folderId);
    if (search) query.set('search', search);
    if (cursor) query.set('before', cursor);
    try {
      const response = await fetch('/api/v1' + base + '/files?' + query, {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const next = await response.json();
      if (!response.ok) {
        if (response.status === 404 && cursor) {
          setCursors([]);
          return;
        }
        throw new Error(next.error ?? t('error'));
      }
      if (active.current && version === loadRevision.current) setData(next as State);
    } catch (e) {
      if (active.current && (e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      if (fetching.current === controller) fetching.current = null;
    }
  }
  loadRef.current = load;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      loadRevision.current++;
      fetching.current?.abort();
      previewRequest.current?.abort();
      xhr.current?.abort();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);
  useEffect(() => {
    setData(undefined);
    const timer = setTimeout(() => void loadRef.current(true), 150);
    const poll = setInterval(() => void loadRef.current(), 2500);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      loadRevision.current++;
      fetching.current?.abort();
      fetching.current = null;
    };
  }, [base, folderId, search, cursor]);
  useEffect(() => {
    if (revision) void loadRef.current();
  }, [revision]);
  useEffect(() => {
    if (!uploading) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [uploading]);
  function navigate(folder: string | null) {
    setFolderId(folder);
    setCursors([]);
    setEditing('');
    setError('');
  }
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await request(base + path, body);
      setEditing('');
      await loadRef.current(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function preparePresentation(id: string) {
    setBusy(true);
    setError('');
    try {
      await onPresentFile?.(id);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function upload(file: File) {
    if (xhr.current || !data?.canUpload) return;
    if (file.size < 1 || file.size > data.maxUploadBytes) {
      setError(t('fileSizeError', { limit: bytes(data.maxUploadBytes) }));
      return;
    }
    setUploading(true);
    setProgress(0);
    setUploadName(file.name);
    setError('');
    const client = new XMLHttpRequest();
    xhr.current = client;
    const query = folderId ? '?folderId=' + encodeURIComponent(folderId) : '';
    client.open('POST', '/api/v1' + base + '/files' + query);
    client.withCredentials = true;
    client.setRequestHeader('x-toaster-file-size', String(file.size));
    client.upload.onprogress = (event) => {
      if (active.current)
        setProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    const finish = () => {
      xhr.current = null;
      if (active.current) {
        setUploading(false);
        setProgress(null);
        void loadRef.current(true);
      }
      if (picker.current) picker.current.value = '';
    };
    client.onload = () => {
      try {
        const response = JSON.parse(client.responseText);
        if (client.status < 200 || client.status >= 300)
          throw new Error(response.error ?? t('fileUploadFailed'));
      } catch (e) {
        if (active.current) setError((e as Error).message);
      }
      finish();
    };
    client.onerror = () => {
      if (active.current) setError(t('fileUploadFailed'));
      finish();
    };
    client.onabort = () => {
      if (active.current) setError(t('fileUploadCancelled'));
      finish();
    };
    client.timeout = 180000;
    client.ontimeout = () => {
      if (active.current) setError(t('fileUploadFailed'));
      finish();
    };
    const form = new FormData();
    form.append('file', file, file.name);
    client.send(form);
  }
  async function download(file: FileItem) {
    setError('');
    try {
      const response = await fetch('/api/v1' + base + '/files/' + file.id + '/content', {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(failure.error ?? t('fileDownloadFailed'));
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    }
  }
  function closePreview() {
    previewRequest.current?.abort();
    previewRequest.current = null;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = '';
    setPreview(undefined);
  }
  async function openPreview(file: FileItem) {
    closePreview();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreview({ file, loading: true });
    dialog.current?.showModal();
    try {
      const response = await fetch('/api/v1' + base + '/files/' + file.id + '/content', {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: file.mediaType === 'text/plain' ? { Range: 'bytes=0-65535' } : {},
      });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(failure.error ?? t('filePreviewFailed'));
      }
      if (file.mediaType === 'text/plain') {
        const text = await response.text();
        if (active.current && previewRequest.current === controller)
          setPreview({ file, text, loading: false });
      } else {
        const blob = await response.blob();
        if (!active.current || previewRequest.current !== controller) return;
        previewUrl.current = URL.createObjectURL(blob);
        setPreview({ file, url: previewUrl.current, loading: false });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && active.current) {
        setError((e as Error).message);
        dialog.current?.close();
      }
    }
  }
  const folders = data?.folders ?? [];
  const crumbs: Folder[] = [];
  let parent = folderId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const item = folders.find((f) => f.id === parent);
    if (!item) break;
    crumbs.unshift(item);
    parent = item.parentId;
  }
  const children = folders.filter((f) => f.parentId === folderId);
  return (
    <section className="file-manager" aria-label={t('fileLibrary')}>
      <header className="section-heading">
        <div>
          <h2>{t('fileLibrary')}</h2>
          <p>{t('fileLibraryHelp')}</p>
        </div>
        <button onClick={() => void load(true)}>{t('refresh')}</button>
      </header>
      {(error || downloads.error) && (
        <p className="error" role="alert">
          {error || downloads.error}
        </p>
      )}
      <div className="file-toolbar">
        <label>
          {t('fileSearch')}
          <input
            type="search"
            dir="auto"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursors([]);
            }}
          />
        </label>
        {data && (
          <p className="file-usage">
            {t('fileStorageUsed', {
              used: bytes(Number(data.usage.usedBytes)),
              total: bytes(Number(data.usage.quotaBytes)),
            })}
          </p>
        )}
      </div>
      {data && !data.enabled && <p role="status">{t('fileStorageUnavailable')}</p>}
      {data?.canUpload && (
        <div
          className="file-dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer.files.length !== 1) {
              setError(t('fileSelectOne'));
              return;
            }
            void upload(event.dataTransfer.files[0]);
          }}
        >
          <input
            className="visually-hidden"
            tabIndex={-1}
            ref={picker}
            aria-label={t('fileChoose')}
            type="file"
            accept=".pdf,.ppt,.pptx,.doc,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <div>
            <strong>{t('fileDropHere')}</strong>
            <p>{t('fileUploadLimit', { limit: bytes(data.maxUploadBytes) })}</p>
          </div>
          <button className="primary" disabled={uploading} onClick={() => picker.current?.click()}>
            {t('fileChoose')}
          </button>
        </div>
      )}
      {uploading && (
        <div className="file-upload-progress" role="status">
          <bdi>{uploadName}</bdi>
          <progress max={100} value={progress ?? undefined} aria-label={t('fileUploadProgress')} />
          <span>
            {t(progress === 100 ? 'fileProcessing' : 'fileUploading')}
            {progress !== null ? ' · ' + number(progress) + '%' : ''}
          </span>
          <button onClick={() => xhr.current?.abort()}>{t('cancel')}</button>
        </div>
      )}
      {data?.enabled && manager && !data.canUpload && (
        <p role="status">{t('fileUploadsUnavailable')}</p>
      )}
      <nav className="file-breadcrumbs" aria-label={t('fileFolderPath')}>
        <button disabled={uploading} onClick={() => navigate(null)}>
          {t('fileRoot')}
        </button>
        {crumbs.map((folder) => (
          <span key={folder.id}>
            {' '}
            /{' '}
            <button disabled={uploading} onClick={() => navigate(folder.id)}>
              <bdi>{folder.name}</bdi>
            </button>
          </span>
        ))}
      </nav>
      {manager && data?.enabled && (
        <details className="file-folder-create">
          <summary>{t('fileNewFolder')}</summary>
          <form
            key={folderId}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              void action('/file-folders', {
                name: new FormData(form).get('name'),
                parentId: folderId,
              }).then((saved) => {
                if (saved) form.reset();
              });
            }}
          >
            <label>
              {t('fileFolderName')}
              <input name="name" required maxLength={200} />
            </label>
            <button disabled={busy || uploading}>{t('create')}</button>
          </form>
        </details>
      )}
      {children.length > 0 && (
        <div className="file-folder-grid">
          {children.map((folder) => (
            <article className="file-folder" key={folder.id}>
              <button disabled={uploading} onClick={() => navigate(folder.id)}>
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />
                </svg>
                <bdi>{folder.name}</bdi>
              </button>
              {manager && (
                <details>
                  <summary>{t('fileFolderActions')}</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action('/file-folders/' + folder.id + '/update', {
                        name: new FormData(e.currentTarget).get('name'),
                      });
                    }}
                  >
                    <label>
                      {t('fileRenameFolder')}
                      <input name="name" defaultValue={folder.name} required maxLength={200} />
                    </label>
                    <button disabled={busy}>{t('fileSave')}</button>
                  </form>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const destination = String(new FormData(e.currentTarget).get('parent'));
                      void action('/file-folders/' + folder.id + '/update', {
                        parentId: destination === 'root' ? null : destination,
                      });
                    }}
                  >
                    <label>
                      {t('fileMoveFolder')}
                      <select
                        aria-label={t('fileMoveTo')}
                        name="parent"
                        defaultValue={folder.parentId ?? 'root'}
                      >
                        <option value="root">{t('fileRoot')}</option>
                        {folders
                          .filter((f) => f.id !== folder.id)
                          .map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button disabled={busy}>{t('fileMove')}</button>
                  </form>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('fileDeleteFolderQuestion', { name: folder.name })))
                        void action('/file-folders/' + folder.id + '/delete', {});
                    }}
                  >
                    {t('fileDeleteFolder')}
                  </button>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      {!data ? (
        <p role="status">{t('loading')}</p>
      ) : data.files.length === 0 ? (
        <div className="empty file-empty">
          <h3>{t(search ? 'fileNoMatches' : 'fileEmpty')}</h3>
          <p>{t('fileEmptyHelp')}</p>
        </div>
      ) : (
        <div className="file-list">
          {data.files.map((file) => (
            <article className="file-row" key={file.id}>
              <div className="file-info">
                <strong>
                  <bdi>{file.name}</bdi>
                </strong>
                <p>
                  {bytes(file.byteSize)} ·{' '}
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    calendar: 'gregory',
                  }).format(new Date(file.createdAt))}
                </p>
                <span className={'file-status file-status-' + file.status}>
                  {t('fileStatus_' + file.status)}
                </span>
                <span className="file-scan-status">{t('fileScan_' + file.scanStatus)}</span>
                {file.failureCode && (
                  <p className="error">{t('fileFailure_' + file.failureCode)}</p>
                )}
              </div>
              <div className="file-actions">
                {file.status === 'ready' && (
                  <>
                    {manager && onPresentFile && (
                      <button disabled={busy} onClick={() => void preparePresentation(file.id)}>
                        {t('presentationPrepare')}
                      </button>
                    )}
                    <DownloadToggle
                      state={downloads}
                      kind="file"
                      targetId={file.id}
                      name={file.name}
                    />
                    <button
                      disabled={!data.enabled || !downloads.canDownload('file', file.id)}
                      title={
                        !downloads.canDownload('file', file.id)
                          ? t('downloadDisabledNotice')
                          : undefined
                      }
                      onClick={() => void download(file)}
                    >
                      {t('fileDownload')}
                    </button>
                    {(file.mediaType === 'text/plain' || file.mediaType?.startsWith('image/')) && (
                      <button
                        disabled={!data.enabled || !downloads.canDownload('file', file.id)}
                        onClick={() => void openPreview(file)}
                      >
                        {t('filePreview')}
                      </button>
                    )}
                  </>
                )}
                {manager &&
                  file.status !== 'uploading' &&
                  (file.status !== 'deleting' || file.failureCode === 'storage_cleanup_failed') && (
                    <details>
                      <summary>{t('fileActions')}</summary>
                      {!['uploading', 'deleting'].includes(file.status) && (
                        <>
                          <button onClick={() => setEditing(editing === file.id ? '' : file.id)}>
                            {t('fileEditDetails')}
                          </button>
                          {file.status === 'ready' && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void action('/files/' + file.id + '/copy', {
                                  name: file.name,
                                  folderId,
                                })
                              }
                            >
                              {t('fileCopy')}
                            </button>
                          )}
                        </>
                      )}
                      {file.status === 'quarantined' && (
                        <button
                          disabled={busy}
                          onClick={() => void action('/files/' + file.id + '/retry-scan', {})}
                        >
                          {t('fileRetryScan')}
                        </button>
                      )}
                      <button
                        disabled={busy || file.status === 'uploading'}
                        onClick={() => {
                          if (window.confirm(t('fileDeleteQuestion', { name: file.name })))
                            void action('/files/' + file.id + '/delete', {});
                        }}
                      >
                        {t(file.status === 'deleting' ? 'fileRetryDelete' : 'fileDelete')}
                      </button>
                    </details>
                  )}
              </div>
              {editing === file.id && (
                <form
                  className="file-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const target = String(form.get('folder'));
                    void action('/files/' + file.id + '/update', {
                      name: form.get('name'),
                      folderId: target === 'root' ? null : target,
                    });
                  }}
                >
                  <label>
                    {t('fileName')}
                    <input name="name" defaultValue={file.name} required maxLength={200} />
                  </label>
                  <label>
                    {t('fileMoveTo')}
                    <select
                      aria-label={t('fileMoveTo')}
                      name="folder"
                      defaultValue={file.folderId ?? 'root'}
                    >
                      <option value="root">{t('fileRoot')}</option>
                      {folders.map((folder) => (
                        <option value={folder.id} key={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button disabled={busy}>{t('fileSave')}</button>
                  <button type="button" onClick={() => setEditing('')}>
                    {t('cancel')}
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}
      {data && (cursors.length > 0 || data.nextCursor) && (
        <div className="file-pagination">
          <button
            disabled={!cursors.length || uploading}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            {t('filePreviousPage')}
          </button>
          <span>{t('filePage', { page: number(cursors.length + 1) })}</span>
          <button
            disabled={!data.nextCursor || uploading}
            onClick={() => {
              if (data.nextCursor) setCursors((values) => [...values, data.nextCursor!]);
            }}
          >
            {t('fileNextPage')}
          </button>
        </div>
      )}
      <dialog ref={dialog} className="file-preview-dialog" onClose={closePreview}>
        <header>
          <h2>
            <bdi>{preview?.file.name}</bdi>
          </h2>
          <button onClick={() => dialog.current?.close()}>{t('fileClosePreview')}</button>
        </header>
        {preview?.loading ? (
          <p role="status">{t('loading')}</p>
        ) : preview?.url ? (
          <img src={preview.url} alt={preview.file.name} />
        ) : (
          <>
            <p>{t('fileTextPreviewLimit')}</p>
            <pre dir="auto">{preview?.text}</pre>
          </>
        )}
      </dialog>
    </section>
  );
}
