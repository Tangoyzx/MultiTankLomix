import type { GameConfig } from '../config.js';
import type { Rng } from '../core/rng.js';

/** 风档是一个便于 UI 展示的整数，实际物理用 acceleration。 */
export class Wind {
  level = 0;

  private readonly config: GameConfig;

  constructor(config: GameConfig) {
    this.config = config;
  }

  get acceleration(): number {
    return this.level * this.config.wind.accelerationPerLevel;
  }

  get maxLevelAbs(): number {
    return Math.max(Math.abs(this.config.wind.minLevel), Math.abs(this.config.wind.maxLevel));
  }

  reset(rng: Rng): void {
    const fixed = this.config.wind.fixedLevel;
    if (fixed !== null) {
      this.level = fixed;
      return;
    }
    this.level = rng.int(this.config.wind.minLevel, this.config.wind.maxLevel);
  }

  reroll(rng: Rng): void {
    if (this.config.wind.fixedLevel !== null) {
      this.level = this.config.wind.fixedLevel;
      return;
    }
    if (this.config.wind.rerollEachTurn) this.reset(rng);
  }
}
