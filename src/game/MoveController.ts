import { CONFIG } from '../config.js';
import { TANK_VISUAL } from '../entities/Tank.js';
import type { Tank } from '../entities/Tank.js';
import type { Terrain } from '../world/Terrain.js';

const EDGE_MARGIN = TANK_VISUAL.bodyWidth * 0.5 + 6;

export type MoveDir = -1 | 0 | 1;

/**
 * 沿地表行走：按弧长扣移动力，上坡同样距离更费；
 * 车身旋转由地形斜率决定，保证车顶对齐地表朝上法线。
 */
export class MoveController {
  dir: MoveDir = 0;
  private queuedDir: -1 | 1 = 1;
  private queuedDistance = 0;

  reset(): void {
    this.dir = 0;
    this.queuedDistance = 0;
  }

  get isMoving(): boolean {
    return this.dir !== 0 || this.queuedDistance > 0;
  }

  /** 远端回放：排队一段待走的距离。 */
  queueRemote(dir: -1 | 1, distance: number): void {
    this.queuedDir = dir;
    this.queuedDistance += distance;
  }

  /**
   * 前方 4 单位处是否过陡到不能走。
   * 上坡用 maxClimbSlope，下坡用更宽松的 maxDescendSlope：站在坡顶往下开不该被拦住。
   */
  isBlocked(dir: -1 | 1, tank: Tank, terrain: Terrain): boolean {
    const config = CONFIG;
    const slopeAhead = terrain.slopeAt(tank.x + dir * 4);
    const downhill = slopeAhead * dir > 0;
    const limit = downhill ? config.terrain.maxDescendSlope : config.terrain.maxClimbSlope;
    return Math.abs(slopeAhead) > limit;
  }

  /** 返回本帧实际消耗的弧长。 */
  update(dt: number, tank: Tank, opponent: Tank | null, terrain: Terrain): number {
    const config = CONFIG;
    let dir: MoveDir = this.dir;
    let cap = Number.POSITIVE_INFINITY;
    if (this.queuedDistance > 0) {
      dir = this.queuedDir;
      cap = this.queuedDistance;
    }
    if (dir === 0) return 0;
    if (tank.movePointsLeft <= 0) {
      this.queuedDistance = 0;
      return 0;
    }

    if (this.isBlocked(dir, tank, terrain)) return 0;

    const slope = terrain.slopeAt(tank.x);
    let arc = Math.min(config.turn.moveSpeed * dt, tank.movePointsLeft, cap);
    if (arc <= 0) {
      this.queuedDistance = 0;
      return 0;
    }
    const dx = (arc / Math.sqrt(1 + slope * slope)) * dir;
    const nextX = tank.x + dx;

    if (nextX < EDGE_MARGIN || nextX > terrain.width - EDGE_MARGIN) return 0;
    if (opponent?.alive && Math.abs(nextX - opponent.x) < config.combat.minTankSeparation) return 0;

    tank.x = nextX;
    tank.y = terrain.heightAt(nextX);
    tank.rotation = terrain.rotationAt(nextX);
    tank.facing = dir === 0 ? tank.facing : dir;
    tank.movePointsLeft = Math.max(0, tank.movePointsLeft - arc);
    if (this.queuedDistance > 0) this.queuedDistance = Math.max(0, this.queuedDistance - arc);

    return arc;
  }
}
