import { z } from 'zod';
export const classroomTheme = z.enum([
  'classic-bbb',
  'modular-skyroom',
  'immersive-glass',
  'studio-hybrid',
]);
export const defaultPermissions = {
  chatEnabled: true,
  handRaiseEnabled: true,
  studentWhiteboardEnabled: false,
  defaultMicrophone: true,
  defaultCamera: true,
  defaultScreenShare: true,
  locked: false,
};
export const platformOptionsSchema = z
  .object({
    siteName: z.string().trim().min(1).max(80).default('TOASTER'),
    welcomeText: z.string().trim().max(300).default(''),
    supportUrl: z
      .string()
      .max(500)
      .refine((value) => {
        if (!value) return true;
        try {
          return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      })
      .default(''),
    defaultLanguage: z.enum(['fa', 'en']).default('fa'),
    defaultTheme: classroomTheme.default('classic-bbb'),
    allowOrgCreation: z.boolean().default(true),
    chatHistoryLimit: z.number().int().min(20).max(200).default(100),
    chatMessageMaxLength: z.number().int().min(200).max(2000).default(2000),
    chatImageMaxMiB: z.number().int().min(1).max(5).default(5),
    geoEnabled: z.boolean().default(true),
    pdfImportEnabled: z.boolean().default(true),
    guestEntryEnabled: z.boolean().default(false),
    guestMaxCapacity: z.number().int().min(1).max(500).default(20),
    defaultPermissions: z
      .object({
        chatEnabled: z.boolean(),
        handRaiseEnabled: z.boolean(),
        studentWhiteboardEnabled: z.boolean(),
        defaultMicrophone: z.boolean(),
        defaultCamera: z.boolean(),
        defaultScreenShare: z.boolean(),
        locked: z.boolean(),
      })
      .strict()
      .default(defaultPermissions),
    defaultLocks: z
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
      .strict()
      .default({
        microphone: false,
        camera: false,
        screenShare: false,
        chat: false,
        chatImages: false,
        whiteboard: false,
        sharedNotes: false,
        raiseHand: false,
      }),
  })
  .strict();
export type PlatformOptions = z.infer<typeof platformOptionsSchema>;
export const DEFAULT_PLATFORM_OPTIONS = platformOptionsSchema.parse({});
