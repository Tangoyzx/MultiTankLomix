import { CONFIG, DERIVED } from '../config.js';
import { Rng } from '../core/rng.js';
import { otherPlayer } from '../core/types.js';
import type { PlayerId } from '../core/types.js';
import { Explosion } from '../entities/Explosion.js';
import type { Projectile } from '../entities/Projectile.js';
import { Tank } from '../entities/Tank.js';
import { generateTerrain } from '../world/TerrainGenerator.js';
import { Wind } from '../world/Wind.js';
import { World } from '../world/World.js';
import type { BallisticsTarget } from './Ballistics.js';
import { findTankType } from './TankTypes.js';

export interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  maxLife: number;
  color: string;
}

export class BattleState {
  readonly seed: number;
  readonly rng: Rng;
  readonly world: World;
  readonly tanks: Record<PlayerId, Tank>;
  activePlayerId: PlayerId = 'left';
  projectile: Projectile | null = null;
  explosions: Explosion[] = [];
  floaters: Floater[] = [];
  turnCount = 0;

  constructor(seed: number, picks: Record<PlayerId, string>) {
    this.seed = seed;
    this.rng = new Rng(seed);
    const terrain = generateTerrain(CONFIG, DERIVED, this.rng.fork(11));
    const wind = new Wind(CONFIG);
    wind.reset(this.rng.fork(23));
    this.world = new World(CONFIG, DERIVED, terrain, wind);

    const leftType = findTankType(picks.left);
    const rightType = findTankType(picks.right);
    const left = new Tank('left', leftType, DERIVED.spawnX.left, 0);
    const right = new Tank('right', rightType, DERIVED.spawnX.right, 0);
    left.syncToGround(terrain);
    right.syncToGround(terrain);
    this.tanks = { left, right };
  }

  get activeTank(): Tank {
    return this.tanks[this.activePlayerId];
  }

  get opponentTank(): Tank {
    return this.tanks[otherPlayer(this.activePlayerId)];
  }

  targets(): BallisticsTarget[] {
    return [
      { id: 'left', x: this.tanks.left.x, y: this.tanks.left.y, hitRadius: CONFIG.combat.tankHitRadius, alive: this.tanks.left.alive },
      { id: 'right', x: this.tanks.right.x, y: this.tanks.right.y, hitRadius: CONFIG.combat.tankHitRadius, alive: this.tanks.right.alive },
    ];
  }

  addFloater(x: number, y: number, text: string, color: string): void {
    this.floaters.push({ x, y, text, life: CONFIG.ui.damageFloatDuration, maxLife: CONFIG.ui.damageFloatDuration, color });
  }

  updateEffects(dt: number): void {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const explosion = this.explosions[i];
      explosion.update(dt);
      if (explosion.done) this.explosions.splice(i, 1);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const floater = this.floaters[i];
      floater.life -= dt;
      floater.y -= 28 * dt;
      if (floater.life <= 0) this.floaters.splice(i, 1);
    }
  }
}
