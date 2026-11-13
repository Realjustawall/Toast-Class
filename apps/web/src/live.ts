import { useEffect, useRef, useState } from 'react';
import { playClassroomSound, type SoundCue } from './classroom-sounds';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied';
export type LiveEvent = { type: string; [key: string]: unknown };
type Listener = {
  status: (value: ConnectionState) => void;
  change: (types: ReadonlySet<string>, events: readonly LiveEvent[]) => void;
};
// Share one transport per classroom.
const channels = new Map<string, ReturnType<typeof channel>>();
function channel(roomId: string) {
  const listeners = new Set<Listener>();
  let socket: WebSocket | undefined;
  let state: ConnectionState = navigator.onLine ? 'connecting' : 'offline';
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let lastMessage = Date.now();
  let stopped = false;
  const status = (value: ConnectionState) => {
    state = value;
    for (const listener of listeners) listener.status(value);
  };
  const change = (type = 'reconcile', event?: LiveEvent) => {
    const types = new Set([type]);
    const events = [event ?? { type }];
    for (const listener of listeners) listener.change(types, events);
  };
  const disconnect = () => {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
    socket = undefined;
  };
  const connect = () => {
    clearTimeout(retry);
    if (stopped || state === 'denied') return;
    disconnect();
    if (!navigator.onLine) {
      status('offline');
      return;
    }
    status(attempt ? 'reconnecting' : 'connecting');
    lastMessage = Date.now();
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/classrooms/${roomId}/live`,
    );
    socket.onmessage = (event) => {
      let message: LiveEvent;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      lastMessage = Date.now();
      if (message.type === 'ready') {
        attempt = 0;
        status('connected');
        change();
      } else if (message.type !== 'heartbeat') {
        const cue: Record<string, SoundCue> = {
          workspace_changed: 'page',
          selection_changed: 'notice',
        };
        if (message.type && cue[message.type]) playClassroomSound(cue[message.type]);
        change(message.type ?? 'changed', message);
      }
    };
    socket.onclose = (event) => {
      socket = undefined;
      if (stopped) return;
      if (event.code === 1008) {
        status('denied');
        change();
        return;
      }
      status(navigator.onLine ? 'reconnecting' : 'offline');
      if (navigator.onLine)
        retry = setTimeout(
          connect,
          Math.min(1000 * 2 ** Math.min(attempt++, 4), 15000) + Math.random() * 500,
        );
    };
    socket.onerror = () => socket?.close();
  };
  const online = () => {
    if (state !== 'denied') connect();
  };
  const offline = () => {
    clearTimeout(retry);
    disconnect();
    status('offline');
  };
  const visible = () => {
    if (document.visibilityState !== 'visible' || state === 'denied') return;
    if (state !== 'connected' || Date.now() - lastMessage > 25000) connect();
    change();
  };
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  document.addEventListener('visibilitychange', visible);
  // Reconcile missed invalidations, including across separate API event buses.
  const watchdog = setInterval(
    () => {
      if (state === 'denied' || !navigator.onLine) return;
      if (Date.now() - lastMessage > 25000) connect();
      change();
    },
    15000 + Math.random() * 5000,
  );
  retry = setTimeout(connect, 0);
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener.status(state);
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stopped = true;
        clearTimeout(retry);
        clearInterval(watchdog);
        disconnect();
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
        document.removeEventListener('visibilitychange', visible);
        channels.delete(roomId);
      };
    },
  };
}

export function useClassroomConnection(
  roomId: string,
  onChange: (events?: readonly LiveEvent[]) => void,
  topics?: readonly string[],
  includeGeneral = true,
) {
  const callback = useRef(onChange);
  const accepted = useRef(topics);
  accepted.current = topics;
  callback.current = onChange;
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => {
    if (!roomId) return;
    let current = channels.get(roomId);
    if (!current) {
      current = channel(roomId);
      channels.set(roomId, current);
    }
    return current.subscribe({
      status: setState,
      change: (types, events) => {
        if (
          types.has('reconcile') ||
          (includeGeneral && types.has('changed')) ||
          (accepted.current
            ? accepted.current.some((topic) => types.has(topic))
            : ![...types].every((type) =>
                [
                  'chat_changed',
                  'chat_categories_changed',
                  'private_chat_changed',
                  'geogebra_changed',
                  'sandbox_changed',
                  'document_changed',
                  'board_changed',
                ].includes(type),
              ))
        )
          callback.current(events);
      },
    });
  }, [roomId]);
  return state;
}

export function useClassroomEvents(
  roomId: string,
  onChange: (events?: readonly LiveEvent[]) => void,
  topics?: readonly string[],
) {
  return useClassroomConnection(roomId, onChange, topics) === 'connected';
}
