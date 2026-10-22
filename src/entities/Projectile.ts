import type { Vec2 } from '../core/types.js';
import type { ProjectileState } from '../game/Ballistics.js';

const MAX_TRAIL_POINTS = 160;

export class Projectile {
  readonly trail: Vec2[] = [];
  readonly state: ProjectileState;
  /** 出膛初速快照：远端回放时用来校验两端弹道是否同源。 */
  readonly launchVelocity: Vec2;
  private trailTimer = 0;

  constructor(state: ProjectileState) {
    this.state = state;
    this.launchVelocity = { x: state.vel.x, y: state.vel.y };
    this.trail.push({ x: state.pos.x, y: state.pos.y });
  }

  get position(): Vec2 {
    return this.state.pos;
  }

  recordTrail(dt: number): void {
    this.trailTimer += dt;
    if (this.trailTimer < 1 / 60) return;
    this.trailTimer = 0;
    this.trail.push({ x: this.state.pos.x, y: this.state.pos.y });
    if (this.trail.length > MAX_TRAIL_POINTS) this.trail.shift();
  }
}
