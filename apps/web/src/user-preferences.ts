import { useSyncExternalStore } from 'react';
import { request } from './api';
import {
  defaultUserPreferences,
  userPreferencesSchema,
  type UserPreferences,
} from '../../../packages/user-preferences';
type Patch<T> = { [K in keyof T]?: T[K] extends object ? Patch<T[K]> : T[K] };
type State = {
  preferences: UserPreferences;
  revision: number;
  ready: boolean;
  authenticated: boolean;
  saving: boolean;
  pending: boolean;
  error: string;
};
let state: State = {
    preferences: structuredClone(defaultUserPreferences),
    revision: 0,
    ready: false,
    authenticated: false,
    saving: false,
    pending: false,
    error: '',
  },
  identity: string | undefined,
  epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  dirty = false,
  serial = 0,
  active: Promise<void> | undefined,
  loading: Promise<void> | undefined,
  controller = new AbortController();
const listeners = new Set<() => void>();
let pendingPatch: Record<string, unknown> = {};
function emit(next: Partial<State>) {
  state = { ...state, ...next, pending: dirty };
  for (const listener of listeners) listener();
  window.dispatchEvent(new CustomEvent('user-preferences-changed', { detail: state.preferences }));
}
const merge = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(patch)])].map((key) => [
      key,
      patch[key] === undefined
        ? base[key]
        : patch[key] !== null && typeof patch[key] === 'object'
          ? merge(
              (base[key] ?? {}) as Record<string, unknown>,
              patch[key] as Record<string, unknown>,
            )
          : patch[key],
    ]),
  );
export function useUserPreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
export function getUserPreferences() {
  return state.preferences;
}
export async function setPreferenceIdentity(id?: string) {
  if (identity === id) return loading;
  identity = id;
  epoch++;
  controller.abort();
  controller = new AbortController();
  clearTimeout(timer);
  dirty = false;
  pendingPatch = {};
  serial++;
  active = undefined;
  emit({
    preferences: structuredClone(defaultUserPreferences),
    revision: 0,
    ready: !id,
    authenticated: !!id,
    saving: false,
    error: '',
  });
  if (!id) return;
  const currentEpoch = epoch;
  loading = request<{ revision: number; preferences: UserPreferences }>(
    '/account/preferences',
    undefined,
    { silent: true, signal: controller.signal },
  )
    .then((result) => {
      if (epoch !== currentEpoch) return;
      emit({
        ...result,
        preferences: userPreferencesSchema.parse(
          dirty
            ? merge(result.preferences as unknown as Record<string, unknown>, pendingPatch)
            : result.preferences,
        ),
        ready: true,
      });
    })
    .catch((error) => {
      if (epoch === currentEpoch) emit({ ready: true, error: error.message });
    });
  return loading;
}
export function updateUserPreferences(patch: Patch<UserPreferences>) {
  const preferences = userPreferencesSchema.parse(
    merge(
      state.preferences as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    ),
  );
  pendingPatch = merge(pendingPatch, patch as Record<string, unknown>);
  serial++;
  dirty = true;
  emit({ preferences, error: '' });
  clearTimeout(timer);
  if (identity) timer = setTimeout(() => void saveUserPreferences().catch(() => {}), 600);
}
export async function saveUserPreferences(): Promise<void> {
  clearTimeout(timer);
  if (active) {
    await active;
    if (dirty) return saveUserPreferences();
    return;
  }
  if (!identity || !dirty) return;
  const currentEpoch = epoch;
  active = (async () => {
    await loading;
    if (epoch !== currentEpoch) return;
    emit({ saving: true, error: '' });
    try {
      while (dirty && epoch === currentEpoch) {
        const currentSerial = serial,
          result = await request<{ revision: number; preferences: UserPreferences }>(
            '/account/preferences',
            { revision: state.revision, preferences: state.preferences },
            { signal: controller.signal },
          );
        if (epoch !== currentEpoch) return;
        dirty = serial !== currentSerial;
        emit({ revision: result.revision });
      }
    } catch (error) {
      if (epoch === currentEpoch) emit({ error: (error as Error).message });
      throw error;
    } finally {
      if (epoch === currentEpoch) emit({ saving: false });
    }
  })();
  try {
    await active;
  } finally {
    if (epoch === currentEpoch) active = undefined;
  }
}
export async function reloadUserPreferences() {
  const id = identity;
  identity = undefined;
  await setPreferenceIdentity(id);
}
