import type { TankTypeConfig } from '../config.js';
import type { PlayerId, Vec2 } from '../core/types.js';
import { degToRad } from '../core/mathx.js';
import type { Terrain } from '../world/Terrain.js';

/** 车体外观尺寸（世界单位），只影响绘制与炮口位置。 */
export const TANK_VISUAL = {
  bodyWidth: 44,
  bodyHeight: 18,
  trackRadius: 5.5,
  barrelLength: 26,
  barrelWidth: 5,
} as const;

/**
 * 炮塔中心在车体局部坐标里的 y（局部 y 轴向上为负）。
 * 渲染与 muzzle() 共用，保证画出来的炮口就是子弹出膛点。
 */
export const TANK_PIVOT_Y = -(TANK_VISUAL.trackRadius * 2 + TANK_VISUAL.bodyHeight);

export class Tank {
  readonly id: PlayerId;
  readonly type: TankTypeConfig;
  hp: number;
  movePointsLeft: number;
  x: number;
  y: number;
  rotation = 0;
  facing: 1 | -1;
  aiming = false;
  aimAngleDeg = 45;
  aimPower = 0;
  aimDirSign: 1 | -1 = 1;
  hitFlash = 0;

  constructor(id: PlayerId, type: TankTypeConfig, x: number, y: number) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.hp = type.hp;
    this.movePointsLeft = type.movePoints;
    this.facing = id === 'left' ? 1 : -1;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  get maxHp(): number {
    return this.type.hp;
  }

  get maxMovePoints(): number {
    return this.type.movePoints;
  }

  get barrelAngleDeg(): number {
    return this.aiming ? this.aimAngleDeg : 45;
  }

  get barrelDirSign(): 1 | -1 {
    return this.aiming ? this.aimDirSign : this.facing;
  }

  syncToGround(terrain: Terrain): void {
    this.y = terrain.heightAt(this.x);
    this.rotation = terrain.rotationAt(this.x);
  }

  /** 炮口位置，子弹从这里出膛。 */
  muzzle(): Vec2 {
    const angle = degToRad(this.barrelAngleDeg);
    const sign = this.barrelDirSign;
    const localX = Math.cos(angle) * TANK_VISUAL.barrelLength * sign;
    const localY = -Math.sin(angle) * TANK_VISUAL.barrelLength + TANK_PIVOT_Y;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return {
      x: this.x + localX * cos - localY * sin,
      y: this.y + localX * sin + localY * cos,
    };
  }

  /**
   * 瞄准基准点（炮塔中心）：不随炮管角度变化，作为拖拽方向与力度的原点。
   * 用它而不是 muzzle()，是为了避免“拖拽 → 改角度 → 炮口移动 → 拖拽”的抖动回路，
   * 同时它离出膛点只有一根炮管的距离，视觉上就是从坦克身上拉出去。
   */
  aimPivot(): Vec2 {
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return {
      x: this.x - TANK_PIVOT_Y * sin,
      y: this.y + TANK_PIVOT_Y * cos,
    };
  }

  update(dt: number): void {
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);
  }
}
