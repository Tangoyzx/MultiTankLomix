export interface Vec2 {
  x: number;
  y: number;
}

export type PlayerId = 'left' | 'right';

export const PLAYER_IDS: readonly PlayerId[] = ['left', 'right'];

export function otherPlayer(id: PlayerId): PlayerId {
  return id === 'left' ? 'right' : 'left';
}

export function playerLabel(id: PlayerId): string {
  return id === 'left' ? '左边玩家' : '右边玩家';
}

export function sideLabel(id: PlayerId): string {
  return id === 'left' ? '左' : '右';
}
