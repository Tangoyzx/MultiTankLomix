import { CONFIG } from '../config.js';
import { clamp, degToRad, radToDeg } from '../core/mathx.js';
import type { Vec2 } from '../core/types.js';
import type { Tank } from '../entities/Tank.js';

export interface AimState {
  active: boolean;
  /** 相对水平的发射仰角（度）。 */
  angleDeg: number;
  power: number;
  dirSign: 1 | -1;
  dragPixels: number;
}

/**
 * 弹弓式瞄准：从坦克往指针的反方向发射，拖拽距离决定力度。
 * 方向由“坦克 → 指针”的反向决定，超出坦克射界时取最近边界。
 */
export class AimController {
  readonly state: AimState = {
    active: false,
    angleDeg: 45,
    power: 0,
    dirSign: 1,
    dragPixels: 0,
  };

  /**
   * 当前视口下“拉满力度”需要的拖拽像素。
   * 默认取 CONFIG，GameApp 会按视口把它换成能完整放进屏幕的力度圆半径。
   */
  maxDragPixels = CONFIG.input.maxDragPixels;

  setMaxDragPixels(px: number): void {
    if (!Number.isFinite(px) || px <= 0) return;
    this.maxDragPixels = px;
  }

  begin(tank: Tank): void {
    this.state.active = true;
    this.state.power = 0;
    this.state.dragPixels = 0;
    this.state.angleDeg = clamp(45, tank.type.minAngleDeg, tank.type.maxAngleDeg);
    this.state.dirSign = tank.facing;
  }

  reset(): void {
    this.state.active = false;
    this.state.power = 0;
    this.state.dragPixels = 0;
  }

  update(tank: Tank, pointerWorld: Vec2, dragPixels: number): void {
    if (!this.state.active) return;
    this.state.dragPixels = dragPixels;
    this.state.power = clamp(dragPixels / this.maxDragPixels, 0, 1);

    // 方向与力度都以坦克的瞄准基准点为原点，和弹弓提示线、轨迹线起点保持一致。
    const pivot = tank.aimPivot();
    let dx = pivot.x - pointerWorld.x;
    let dy = pivot.y - pointerWorld.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    dx /= len;
    dy /= len;

    const sign: 1 | -1 = Math.abs(dx) < 0.08 ? tank.facing : dx > 0 ? 1 : -1;
    const raw = radToDeg(Math.atan2(-dy, Math.abs(dx)));
    this.state.dirSign = sign;
    this.state.angleDeg = clamp(raw, tank.type.minAngleDeg, tank.type.maxAngleDeg);

    tank.aimAngleDeg = this.state.angleDeg;
    tank.aimPower = this.state.power;
    tank.aimDirSign = sign;
  }

  velocity(tank: Tank): Vec2 {
    const angle = degToRad(this.state.angleDeg);
    const speed = this.state.power * tank.type.maxLaunchSpeed;
    return {
      x: Math.cos(angle) * speed * this.state.dirSign,
      y: -Math.sin(angle) * speed,
    };
  }
}
