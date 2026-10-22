import type { GameConfig } from '../config.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  life: number;
  maxLife: number;
}

export class Explosion {
  readonly particles: Particle[] = [];
  readonly radius: number;
  private readonly config: GameConfig;
  private life = 0;

  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number, config: GameConfig, rng: () => number) {
    this.x = x;
    this.y = y;
    this.config = config;
    this.radius = config.combat.explosionRadius;
    const count = 22;
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const speed = (0.35 + rng() * 0.65) * this.radius * 4.5;
      const maxLife = 0.35 + rng() * 0.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - this.radius * 1.2,
        radius: this.radius * (0.06 + rng() * 0.12),
        life: maxLife,
        maxLife,
      });
    }
  }

  get maxLife(): number {
    return this.config.turn.explosionLifetime;
  }

  get progress(): number {
    return Math.min(1, this.life / this.maxLife);
  }

  get done(): boolean {
    return this.life >= this.maxLife;
  }

  update(dt: number): void {
    this.life += dt;
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += this.config.physics.gravity * 0.55 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
}
