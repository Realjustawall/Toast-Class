import { useCallback, useEffect, useRef } from 'react';
import { getUserPreferences, useUserPreferences, updateUserPreferences } from './user-preferences';
export type SoundCue =
  | 'join'
  | 'leave'
  | 'message'
  | 'hand'
  | 'connected'
  | 'enabled'
  | 'disabled'
  | 'click'
  | 'change'
  | 'error'
  | 'success'
  | 'connecting'
  | 'disconnected'
  | 'reconnecting'
  | 'microphoneOn'
  | 'microphoneOff'
  | 'cameraOn'
  | 'cameraOff'
  | 'screenOn'
  | 'screenOff'
  | 'lock'
  | 'unlock'
  | 'page'
  | 'session'
  | 'poll'
  | 'timer'
  | 'notice';
const notes: Record<SoundCue, number[]> = {
  enabled: [600, 900],
  disabled: [600, 350],
  join: [523, 659],
  leave: [659, 440],
  message: [880],
  hand: [659, 784, 988],
  connected: [440, 554, 659],
  click: [1000],
  change: [740, 880],
  error: [240, 180],
  success: [659, 880],
  connecting: [330, 440],
  disconnected: [440, 330, 220],
  reconnecting: [330, 392],
  microphoneOn: [660, 990],
  microphoneOff: [660, 330],
  cameraOn: [520, 780],
  cameraOff: [520, 260],
  screenOn: [440, 660, 880],
  screenOff: [880, 660, 440],
  lock: [350, 280],
  unlock: [280, 420],
  page: [600, 750],
  session: [440, 660, 880, 1100],
  poll: [587, 740, 880],
  timer: [880, 880, 1175],
  notice: [523, 784],
};
const category = (cue: SoundCue) =>
  ['click', 'change'].includes(cue)
    ? 'actions'
    : [
          'connected',
          'disconnected',
          'connecting',
          'reconnecting',
          'enabled',
          'disabled',
          'microphoneOn',
          'microphoneOff',
          'cameraOn',
          'cameraOff',
          'screenOn',
          'screenOff',
        ].includes(cue)
      ? 'devices'
      : ['join', 'leave', 'message', 'hand', 'notice'].includes(cue)
        ? 'notifications'
        : 'classroom';
let audio: AudioContext | undefined;
const last = new Map<string, number>();
export async function unlockClassroomSounds() {
  if (!getUserPreferences().sounds.enabled) return;
  audio ??= new AudioContext();
  if (audio.state === 'suspended') await audio.resume();
}
export function playClassroomSound(cue: SoundCue, preview = false) {
  const prefs = getUserPreferences().sounds;
  if (
    !prefs.enabled ||
    (!preview && !prefs[category(cue)]) ||
    !prefs.volume ||
    !audio ||
    audio.state !== 'running'
  )
    return;
  const now = performance.now();
  if (now - (last.get(cue) ?? -Infinity) < (cue === 'click' ? 70 : 250)) return;
  last.set(cue, now);
  notes[cue].forEach((frequency, index) => {
    const oscillator = audio!.createOscillator(),
      gain = audio!.createGain(),
      at = audio!.currentTime + index * 0.085;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime((cue === 'click' ? 0.022 : 0.09) * prefs.volume, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    oscillator.connect(gain);
    gain.connect(audio!.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(at);
    oscillator.stop(at + 0.13);
  });
  window.dispatchEvent(
    new CustomEvent('classroom-sound-played', {
      detail: { cue, category: category(cue), volume: prefs.volume },
    }),
  );
}
export function installApplicationSounds() {
  const unlock = () => void unlockClassroomSounds().catch(() => {}),
    click = (event: Event) => {
      const target = (event.target as Element)?.closest?.('button,a,summary,[role=button]');
      if (
        target &&
        !target.hasAttribute('disabled') &&
        target.getAttribute('aria-disabled') !== 'true'
      )
        playClassroomSound('click');
    },
    change = (event: Event) => {
      if (
        (event.target as Element)?.matches?.(
          'select,input[type=checkbox],input[type=radio],input[type=number],input[type=color],input[type=range]',
        )
      )
        playClassroomSound('change');
    },
    toast = (event: Event) =>
      playClassroomSound((event as CustomEvent).detail?.tone === 'error' ? 'error' : 'success');
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  document.addEventListener('click', click);
  document.addEventListener('change', change);
  window.addEventListener('classroom-feedback', toast);
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    document.removeEventListener('click', click);
    document.removeEventListener('change', change);
    window.removeEventListener('classroom-feedback', toast);
  };
}
export function useClassroomSounds(
  participants: readonly { id: string }[],
  hands: readonly { user_id: string }[],
  userId?: string,
) {
  const { preferences } = useUserPreferences(),
    previous = useRef<{ people: Set<string>; hands: Set<string> } | undefined>(undefined);
  useEffect(() => {
    const next = {
      people: new Set(participants.map((p) => p.id)),
      hands: new Set(hands.map((h) => h.user_id)),
    };
    if (previous.current) {
      if ([...next.hands].some((id) => id !== userId && !previous.current!.hands.has(id)))
        playClassroomSound('hand');
      if ([...next.people].some((id) => id !== userId && !previous.current!.people.has(id)))
        playClassroomSound('join');
      if ([...previous.current.people].some((id) => id !== userId && !next.people.has(id)))
        playClassroomSound('leave');
    }
    previous.current = next;
  }, [participants, hands, userId]);
  const toggle = useCallback(() => {
    updateUserPreferences({ sounds: { enabled: !getUserPreferences().sounds.enabled } });
    void unlockClassroomSounds()
      .then(() => playClassroomSound('connected'))
      .catch(() => {});
  }, []);
  return { sounds: preferences.sounds.enabled, toggle };
}
