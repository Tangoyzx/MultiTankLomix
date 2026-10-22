export const PALETTE = {
  skyTop: '#16233a',
  skyMiddle: '#2b4468',
  skyBottom: '#5a7fa6',
  outOfWorld: '#0d131f',
  hillFar: 'rgba(38, 58, 88, 0.75)',
  hillNear: 'rgba(28, 44, 68, 0.9)',
  soilTop: '#6f8f4a',
  soilMid: '#5b6f3a',
  soilDeep: '#3b4a2a',
  skin: '#8fbe57',
  skinEdge: '#b7e07a',
  tankLeft: '#3fa9f5',
  tankLeftDark: '#1c6fa8',
  tankRight: '#f5843f',
  tankRightDark: '#a84f1c',
  tankMetal: '#d8dee6',
  tankMetalDark: '#8d99a8',
  barrel: '#4a5364',
  hpBack: 'rgba(12, 18, 28, 0.65)',
  hpFill: '#69d17a',
  hpFillLow: '#e0574f',
  trail: 'rgba(255, 255, 255, 0.55)',
  preview: '#ffe08a',
  previewHit: '#ff8a5c',
  activeRing: '#ffd166',
  text: '#eaf2ff',
} as const;

export function tankColors(id: string): { body: string; dark: string } {
  return id === 'left'
    ? { body: PALETTE.tankLeft, dark: PALETTE.tankLeftDark }
    : { body: PALETTE.tankRight, dark: PALETTE.tankRightDark };
}
