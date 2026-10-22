import { distanceToSegment } from '../core/mathx.js';
import type { Vec2 } from '../core/types.js';

export interface ProjectileState {
  pos: Vec2;
  vel: Vec2;
  prev: Vec2;
  elapsed: number;
}

export interface BallisticsTarget {
  id: string;
  x: number;
  y: number;
  hitRadius: number;
  alive: boolean;
}

export interface SurfaceLike {
  heightAt(x: number): number;
  refineSurfaceHit(from: Vec2, to: Vec2): Vec2;
}

export interface KillBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface BallisticsContext {
  gravity: number;
  windAccel: number;
  subStep: number;
  airDrag: number;
  killBounds: KillBounds;
  terrain: SurfaceLike;
  targets: readonly BallisticsTarget[];
  /** 出膛后短时间内忽略的目标，避免自伤。 */
  ignoreTargetId: string | null;
  graceSeconds: number;
}

export type HitKind = 'terrain' | 'tank' | 'out';

export interface Hit {
  kind: HitKind;
  point: Vec2;
  targetId: string | null;
}

export function createState(origin: Vec2, velocity: Vec2): ProjectileState {
  return {
    pos: { x: origin.x, y: origin.y },
    prev: { x: origin.x, y: origin.y },
    vel: { x: velocity.x, y: velocity.y },
    elapsed: 0,
  };
}

function stepOnce(state: ProjectileState, h: number, ctx: BallisticsContext): Hit | null {
  state.prev.x = state.pos.x;
  state.prev.y = state.pos.y;

  state.vel.x += (ctx.windAccel - state.vel.x * ctx.airDrag) * h;
  state.vel.y += (ctx.gravity - state.vel.y * ctx.airDrag) * h;
  state.pos.x += state.vel.x * h;
  state.pos.y += state.vel.y * h;
  state.elapsed += h;

  const b = ctx.killBounds;
  if (state.pos.x < b.minX || state.pos.x > b.maxX || state.pos.y < b.minY || state.pos.y > b.maxY) {
    return { kind: 'out', point: { x: state.pos.x, y: state.pos.y }, targetId: null };
  }

  const graced = ctx.ignoreTargetId !== null && state.elapsed < ctx.graceSeconds;
  for (const target of ctx.targets) {
    if (!target.alive) continue;
    if (graced && target.id === ctx.ignoreTargetId) continue;
    const d = distanceToSegment(target.x, target.y, state.prev.x, state.prev.y, state.pos.x, state.pos.y);
    if (d <= target.hitRadius) {
      return { kind: 'tank', point: { x: target.x, y: target.y }, targetId: target.id };
    }
  }

  if (state.pos.y >= ctx.terrain.heightAt(state.pos.x)) {
    const point = ctx.terrain.refineSurfaceHit(state.prev, state.pos);
    return { kind: 'terrain', point, targetId: null };
  }

  return null;
}

/** 推进一帧（内部按 subStep 细分），返回命中信息或 null。 */
export function advance(state: ProjectileState, dt: number, ctx: BallisticsContext): Hit | null {
  const steps = Math.max(1, Math.min(64, Math.ceil(dt / ctx.subStep)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const hit = stepOnce(state, h, ctx);
    if (hit) return hit;
  }
  return null;
}

export interface PreviewPath {
  points: Vec2[];
  hit: Hit | null;
}

/**
 * 无风弹道预览：与实弹共用同一套积分，只把风力置零，
 * 所以预览与真实弹道的偏差恰好就是风的影响。
 */
export function previewPath(
  origin: Vec2,
  velocity: Vec2,
  ctx: BallisticsContext,
  maxSeconds: number,
  sampleEverySteps: number,
  maxPoints: number,
): PreviewPath {
  const state = createState(origin, velocity);
  const points: Vec2[] = [{ x: origin.x, y: origin.y }];
  const maxSteps = Math.ceil(maxSeconds / ctx.subStep);
  let steps = 0;
  let hit: Hit | null = null;

  while (steps < maxSteps && points.length < maxPoints) {
    for (let i = 0; i < sampleEverySteps && steps < maxSteps; i++) {
      hit = stepOnce(state, ctx.subStep, ctx);
      steps++;
      if (hit) break;
    }
    points.push({ x: state.pos.x, y: state.pos.y });
    if (hit) break;
  }

  return { points, hit };
}
