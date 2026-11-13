import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomConnection } from './live';
import { buildSandboxSrcDoc, type SandboxBundle } from './sandbox-bundle';

type SandboxSummary = {
  id: string;
  name: string;
  revision: number;
  updated_at: string;
};

type SandboxBoard = SandboxSummary & {
  bundle: SandboxBundle;
  canEdit: boolean;
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('Could not read file'));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export default function SandboxWorkspace({
  roomId,
  selectedId,
  canSelect,
  onSelect,
}: {
  roomId: string;
  selectedId: string | null;
  canSelect: boolean;
  onSelect: (id: string | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const base = '/classrooms/' + roomId + '/sandbox';
  const [boards, setBoards] = useState<SandboxSummary[]>([]);
  const [board, setBoard] = useState<SandboxBoard | null>(null);
  const [boardName, setBoardName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runNonce, setRunNonce] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const list = await request<SandboxSummary[]>(base, undefined, { silent: true });
      setBoards(list);
      if (selectedId && !list.some((item) => item.id === selectedId)) {
        setBoard(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useClassroomConnection(roomId, () => void refresh(), ['sandbox_changed']);

  useEffect(() => {
    void refresh();
  }, [roomId]);

  useEffect(() => {
    if (!selectedId) {
      setBoard(null);
      return;
    }
    let cancelled = false;
    setError('');
    void request<SandboxBoard>(base + '/' + selectedId, undefined, { silent: true })
      .then((loaded) => {
        if (!cancelled) setBoard(loaded);
      })
      .catch((e) => {
        if (!cancelled) {
          setBoard(null);
          setError((e as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, selectedId]);

  const srcDoc = useMemo(() => (board ? buildSandboxSrcDoc(board.bundle) : ''), [board]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const contentBase64 = await readFileAsBase64(file);
      const fallbackName = file.name.replace(/\.(html?|zip)$/i, '') || 'Interactive board';
      const created = await request<{ id: string }>(base, {
        name: boardName.trim() || fallbackName,
        fileName: file.name,
        contentBase64,
      });
      setBoardName('');
      await refresh();
      await onSelect(created.id);
      setRunNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeBoard = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      await request(base + '/' + selectedId + '/delete', {});
      const remaining = boards.filter((item) => item.id !== selectedId);
      setBoards(remaining);
      setBoard(null);
      await onSelect(remaining[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sandbox-workspace" aria-label={t('sandboxTitle')}>
      <header className="sandbox-toolbar">
        <label className="sandbox-picker">
          <span>{t('sandboxBoardLabel')}</span>
          <select
            value={selectedId ?? ''}
            disabled={!canSelect || busy || !boards.length}
            onChange={(e) => void onSelect(e.target.value || null)}
          >
            {!boards.length && <option value="">{t('sandboxNone')}</option>}
            {boards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {canSelect && (
          <div className="sandbox-upload-controls">
            <input
              type="text"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              placeholder={t('sandboxNamePlaceholder')}
              aria-label={t('sandboxNamePlaceholder')}
              maxLength={120}
              disabled={busy}
            />
            <input
              ref={fileInput}
              type="file"
              accept=".html,.htm,.zip,text/html,application/zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? t('sandboxUploading') : t('sandboxUpload')}
            </button>
            {selectedId && (
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void removeBoard()}
              >
                {t('sandboxDelete')}
              </button>
            )}
          </div>
        )}
        {board && (
          <button type="button" className="quiet" onClick={() => setRunNonce((n) => n + 1)}>
            {t('sandboxRerun')}
          </button>
        )}
        <span className="sandbox-isolation-badge" title={t('sandboxIsolatedHint')}>
          {t('sandboxIsolatedBadge')}
        </span>
      </header>
      {error && (
        <div className="geogebra-notice" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="sandbox-frame-container">
        {board ? (
          <iframe
            key={board.id + ':' + board.revision + ':' + runNonce}
            title={board.name}
            className="sandbox-frame"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
          />
        ) : (
          <div className="geogebra-empty">
            <h3>{t('sandboxEmptyTitle')}</h3>
            <p>{t('sandboxEmptyBody')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
