import type { Vec2 } from './types.js';

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return clamp((value - a) / (b - a), 0, 1);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = inverseLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return distance(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return distance(px, py, ax + abx * t, ay + aby * t);
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

/** 指数逼近，帧率无关的平滑跟随。 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}
