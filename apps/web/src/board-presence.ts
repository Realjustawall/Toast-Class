import { useEffect, useRef, useState } from 'react';
import { request } from './api';

export type BoardPointer = { x: number; y: number; tool: 'pointer' | 'laser' };
export type BoardPeer = {
  id: string;
  userId: string;
  name: string;
  pointer: BoardPointer;
  button: 'up' | 'down';
  updatedAt: number;
};
export function useBoardPresence(
  base: string,
  generation: string,
  enabled: boolean,
  canPublish: boolean,
) {
  const [peers, setPeers] = useState<BoardPeer[]>([]),
    [connected, setConnected] = useState(false);
  const [viewTick, setViewTick] = useState(0);
  const clientId = useRef(crypto.randomUUID()),
    socket = useRef<WebSocket | undefined>(undefined);
  const publishing = useRef(canPublish);
  publishing.current = canPublish;
  const pending = useRef<{ pointer: BoardPointer | null; button: 'up' | 'down' } | undefined>(
    undefined,
  );
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !generation) {
      setPeers([]);
      setConnected(false);
      return;
    }
    setPeers([]);
    setConnected(false);
    let closed = false,
      ownId = '',
      attempt = 0,
      reading = false,
      again = false,
      lastRead = 0;
    let retry: ReturnType<typeof setTimeout> | undefined,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    async function refresh() {
      if (closed) return;
      if (reading) {
        again = true;
        return;
      }
      const wait = 200 - (Date.now() - lastRead);
      if (wait > 0) {
        if (!refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
          }, wait);
        return;
      }
      reading = true;
      lastRead = Date.now();
      try {
        const result = await request<{ generation: string; peers: BoardPeer[] }>(
          base + '/presence',
          undefined,
          { signal: abort.signal },
        );
        if (!closed && socket.current?.readyState === WebSocket.OPEN) {
          setConnected(true);
          setPeers(
            result.generation === generation
              ? result.peers.filter((peer) => peer.id !== ownId)
              : [],
          );
        }
      } catch {
        if (!closed) {
          setPeers([]);
          setConnected(false);
        }
      } finally {
        reading = false;
        if (again && !closed) {
          again = false;
          void refresh();
        }
      }
    }
    function connect() {
      if (closed) return;
      const current = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1${base}/presence/live?clientId=${clientId.current}`,
      );
      socket.current = current;
      current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready' && typeof data.id === 'string') {
            ownId = data.id;
            attempt = 0;
            setConnected(true);
            setViewTick((value) => value + 1);
            void refresh();
          } else if (data.type === 'presence_changed') {
            if (Array.isArray(data.peers)) {
              setConnected(true);
              setPeers(
                data.generation === generation
                  ? data.peers.filter((peer: BoardPeer) => peer.id !== ownId)
                  : [],
              );
            } else {
              void refresh();
            }
          } else if (data.type === 'view_changed') setViewTick((value) => value + 1);
        } catch {
          current.close();
        }
      };
      current.onclose = () => {
        if (!closed) {
          setConnected(false);
          setPeers([]);
          if (attempt < 8) retry = setTimeout(connect, Math.min(500 * 2 ** attempt++, 15000));
        }
      };
      current.onerror = () => current.close();
    }
    connect();
    const recover = () => {
      attempt = 0;
      if (socket.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(retry);
        connect();
      } else if (socket.current?.readyState === WebSocket.OPEN) void refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      closed = true;
      abort.abort();
      clearTimeout(retry);
      clearTimeout(refreshTimer);
      clearTimeout(publishTimer.current);
      publishTimer.current = undefined;
      pending.current = undefined;
      socket.current?.close();
      socket.current = undefined;
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [base, generation, enabled]);
  const send = (pointer: BoardPointer | null, button: 'up' | 'down' = 'up') => {
    if (!publishing.current || !enabled) return;
    pending.current = { pointer, button };
    if (publishTimer.current) return;
    publishTimer.current = setTimeout(() => {
      publishTimer.current = undefined;
      if (
        socket.current?.readyState === WebSocket.OPEN &&
        socket.current.bufferedAmount < 8192 &&
        publishing.current &&
        pending.current
      ) {
        socket.current.send(JSON.stringify({ generation, ...pending.current }));
        pending.current = undefined;
      }
    }, 25);
  };
  return { peers, connected, send, viewTick };
}
