import { z } from 'zod';
export const userFontFamilies = [1, 2, 3, 5, 6, 7, 8, 9] as const;
export type UserFontFamily = (typeof userFontFamilies)[number];
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const ink = z
  .object({
    color,
    width: z.number().finite().min(0.1).max(100),
    opacity: z.number().int().min(1).max(100),
  })
  .strict();
const layout = z
  .object({
    people: z.number().finite().min(80).max(460),
    chat: z.number().finite().min(80).max(460),
    mediaHeight: z.number().finite().min(80).max(460),
    mediaWidth: z.number().finite().min(80).max(460),
    text: z.number().int().min(12).max(22),
  })
  .strict();
export const userPreferencesSchema = z
  .object({
    language: z.enum(['fa', 'en']).nullable(),
    layouts: z
      .object({
        'classic-bbb': layout.optional(),
        'modular-skyroom': layout.optional(),
        'immersive-glass': layout.optional(),
        'studio-hybrid': layout.optional(),
      })
      .strict()
      .default({}),
    tools: z
      .object({
        pen: ink,
        pressurePen: ink
          .extend({ sensitivity: z.number().finite().min(0.25).max(3) })
          .default({ color: '#1f2937', width: 2, opacity: 100, sensitivity: 1 }),
        highlighter: ink,
        eraserSize: z.number().finite().min(2).max(200),
        text: z
          .object({
            color,
            fontSize: z.number().finite().min(8).max(256),
            fontFamily: z.union([
              z.literal(1),
              z.literal(2),
              z.literal(3),
              z.literal(5),
              z.literal(6),
              z.literal(7),
              z.literal(8),
              z.literal(9),
            ]),
            textAlign: z.enum(['left', 'center', 'right']),
            opacity: z.number().int().min(1).max(100),
          })
          .strict(),
      })
      .strict(),
    sounds: z
      .object({
        enabled: z.boolean(),
        volume: z.number().finite().min(0).max(1),
        actions: z.boolean(),
        devices: z.boolean(),
        notifications: z.boolean(),
        classroom: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export const defaultUserPreferences: UserPreferences = {
  language: null,
  layouts: {},
  tools: {
    pen: { color: '#1f2937', width: 2, opacity: 100 },
    pressurePen: { color: '#1f2937', width: 2, opacity: 100, sensitivity: 1 },
    highlighter: { color: '#facc15', width: 4, opacity: 30 },
    eraserSize: 24,
    text: { color: '#1f2937', fontSize: 20, fontFamily: 2, textAlign: 'left', opacity: 100 },
  },
  sounds: {
    enabled: true,
    volume: 0.5,
    actions: true,
    devices: true,
    notifications: true,
    classroom: true,
  },
};
