import { useEffect, useRef, useState } from 'react';
import { request } from './api';

export type Viewport = { centerX: number; centerY: number; zoom: number };
export type PresenterView = {
  generation: string;
  revision: number;
  active: boolean;
  actorId: string | null;
  viewport: Viewport | null;
  canPresent: boolean;
};
type Command = {
  generation: string;
  revision: number;
  operationId: string;
  active: boolean;
  viewport: Viewport;
};
const same = (a: Viewport | null, b: Viewport) =>
  !!a &&
  Math.abs(a.centerX - b.centerX) < 0.01 &&
  Math.abs(a.centerY - b.centerY) < 0.01 &&
  Math.abs(a.zoom - b.zoom) < 0.0001;

/** One coalesced pending frame; ambiguous failures retain the exact command for explicit retry. */
export function useBoardPresenter(
  base: string,
  generation: string,
  tick: number,
  userId: string,
  editable = false,
) {
  const [view, setView] = useState<PresenterView>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef(view),
    currentGeneration = useRef(generation),
    latest = useRef<Viewport | undefined>(undefined),
    failed = useRef<Command | undefined>(undefined),
    running = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    alive = useRef(true);
  currentGeneration.current = generation;
  const update = (value: PresenterView) => {
    current.current = value;
    if (alive.current) setView(value);
  };
  async function refresh(signal?: AbortSignal) {
    const value = await request<PresenterView>(base + '/view', undefined, { signal });
    if (
      alive.current &&
      value.generation === currentGeneration.current &&
      !signal?.aborted &&
      (!current.current || value.revision >= current.current.revision)
    )
      update(value);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      latest.current = undefined;
    };
  }, [base]);
  useEffect(() => {
    if (!generation) return;
    const abort = new AbortController();
    void refresh(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => abort.abort();
  }, [base, generation, tick, editable]);
  useEffect(() => {
    latest.current = undefined;
    failed.current = undefined;
    setError('');
  }, [generation]);
  async function send(command: Command) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await request<{ revision: number }>(base + '/view', command);
      failed.current = undefined;
      if (alive.current && command.generation === currentGeneration.current) {
        update({
          generation: command.generation,
          revision: result.revision,
          active: command.active,
          actorId: userId,
          viewport: command.viewport,
          canPresent: true,
        });
        setError('');
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        // A definitive conflict/denial must never be automatically rebased over another presenter.
        const status = (e as Error & { status?: number }).status;
        failed.current = status && status >= 400 && status < 500 ? undefined : command;
        latest.current = undefined;
        await refresh().catch(() => {});
      }
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        if (latest.current && !failed.current) schedule();
      }
    }
  }
  function schedule() {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (running.current || failed.current) return;
      const value = latest.current,
        state = current.current;
      latest.current = undefined;
      if (
        value &&
        state?.active &&
        state.actorId === userId &&
        state.generation === generation &&
        !same(state.viewport, value)
      )
        void send({
          generation,
          revision: state.revision,
          operationId: crypto.randomUUID(),
          active: true,
          viewport: value,
        });
    }, 30);
  }
  function move(value: Viewport) {
    if (!current.current?.active || current.current.actorId !== userId || failed.current) return;
    if (same(current.current.viewport, value)) return;
    latest.current = value;
    schedule();
  }
  async function toggle(viewport: Viewport) {
    const state = current.current;
    if (!state?.canPresent || running.current) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    latest.current = undefined;
    if (failed.current) {
      await send(failed.current);
      return;
    }
    await send({
      generation,
      revision: state.revision,
      operationId: crypto.randomUUID(),
      active: !(state.active && state.actorId === userId),
      viewport,
    });
  }
  return { view, busy, error, move, toggle };
}
