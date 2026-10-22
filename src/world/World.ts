import type { DerivedConfig, GameConfig } from '../config.js';
import type { Vec2 } from '../core/types.js';
import type { Terrain } from './Terrain.js';
import type { Wind } from './Wind.js';

/** 一局的静态环境：地形 + 风 + 边界判定。 */
export class World {
  readonly config: GameConfig;
  readonly derived: DerivedConfig;
  readonly terrain: Terrain;
  readonly wind: Wind;

  constructor(config: GameConfig, derived: DerivedConfig, terrain: Terrain, wind: Wind) {
    this.config = config;
    this.derived = derived;
    this.terrain = terrain;
    this.wind = wind;
  }

  get width(): number {
    return this.config.world.width;
  }

  get height(): number {
    return this.config.world.height;
  }

  isOutOfBounds(p: Vec2): boolean {
    const b = this.derived.killBounds;
    return p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY;
  }
}
