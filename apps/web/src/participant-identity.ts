import type { CSSProperties } from 'react';
const colors = ['#1463b8', '#8650a5', '#087c69', '#b14b20', '#a43d64', '#3d6790'];
export function participantColor(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return colors[(hash >>> 0) % colors.length];
}
export function participantAvatarStyle(id: string, moderator: boolean): CSSProperties {
  return { backgroundColor: participantColor(id), borderRadius: moderator ? '6px' : '50%' };
}
