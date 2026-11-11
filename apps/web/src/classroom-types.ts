export type MediaIntent = { microphone: boolean; camera: boolean };
export type ParticipantMediaState = {
  id: string;
  microphone: boolean;
  camera: boolean;
  screenShare: boolean;
};

export type ClassroomTheme =
  'classic-bbb' | 'modular-skyroom' | 'immersive-glass' | 'studio-hybrid';

export type ClassroomPermissions = {
  chatEnabled: boolean;
  handRaiseEnabled: boolean;
  studentWhiteboardEnabled: boolean;
  defaultMicrophone: boolean;
  defaultCamera: boolean;
  defaultScreenShare: boolean;
  locked: boolean;
};

export const DEFAULT_CLASSROOM_PERMISSIONS: ClassroomPermissions = {
  chatEnabled: true,
  handRaiseEnabled: true,
  studentWhiteboardEnabled: false,
  defaultMicrophone: true,
  defaultCamera: true,
  defaultScreenShare: true,
  locked: false,
};

export type ClassroomView = {
  id: string;
  name: string;
  theme?: ClassroomTheme;
  permissions?: ClassroomPermissions;
  pinnedNotice?: string;
  externalMediaUrl?: string;
  parent?: { id: string; name: string; groupId: string };
  mediaResume?: MediaIntent;
};

export type UserEffectivePermissions = {
  overrides?: {
    canWhiteboard?: boolean | null;
    canSharedNotes?: boolean | null;
    canScreenShare?: boolean | null;
  };
  canSharedNotes: boolean;
  lockExempt?: boolean;
  canChat: boolean;
  canChatImages: boolean;
  interactionLocked: boolean;
  canWhiteboard: boolean;
  canMicrophone: boolean;
  canCamera: boolean;
  canScreenShare: boolean;
  canRaiseHand: boolean;
  isPresenter: boolean;
  kicked: boolean;
};

export type UserPermissionOverride = {
  revision?: number;
  canSharedNotes?: boolean | null;
  lockExempt?: boolean;
  userId: string;
  name?: string;
  email?: string;
  role?: string;
  canChat: boolean | null;
  canChatImages: boolean | null;
  interactionLocked: boolean;
  canWhiteboard: boolean | null;
  canMicrophone: boolean | null;
  canCamera: boolean | null;
  canScreenShare: boolean | null;
  canRaiseHand: boolean | null;
  isPresenter: boolean;
  kicked: boolean;
  effective?: UserEffectivePermissions;
};

export type ParticipantStatusKind =
  'none' | 'agree' | 'disagree' | 'applause' | 'confused' | 'away';

export const STATUS_EMOJIS: Record<ParticipantStatusKind, string> = {
  none: '',
  agree: '👍',
  disagree: '👎',
  applause: '👏',
  confused: '😕',
  away: '☕',
};
