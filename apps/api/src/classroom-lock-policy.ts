import { z } from 'zod';
export const lockPolicySchema = z
  .object({
    microphone: z.boolean(),
    camera: z.boolean(),
    screenShare: z.boolean(),
    chat: z.boolean(),
    chatImages: z.boolean(),
    whiteboard: z.boolean(),
    sharedNotes: z.boolean(),
    raiseHand: z.boolean(),
  })
  .strict();
export const unlockedPolicy = {
  microphone: false,
  camera: false,
  screenShare: false,
  chat: false,
  chatImages: false,
  whiteboard: false,
  sharedNotes: false,
  raiseHand: false,
};
export type LockPolicy = z.infer<typeof lockPolicySchema>;
export function roomLockPolicy(value: unknown): LockPolicy {
  if (value == null) return { ...unlockedPolicy };
  try {
    return lockPolicySchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    return Object.fromEntries(Object.keys(unlockedPolicy).map((key) => [key, true])) as LockPolicy;
  }
}
