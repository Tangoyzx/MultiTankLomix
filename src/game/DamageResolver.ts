import type { GameConfig } from '../config.js';
import { clamp, lerp } from '../core/mathx.js';
import type { PlayerId } from '../core/types.js';
import { PLAYER_IDS } from '../core/types.js';
import type { Tank } from '../entities/Tank.js';
import type { Hit } from './Ballistics.js';

export interface DamageResult {
  targetId: PlayerId;
  damage: number;
  hp: number;
  direct: boolean;
}

function applyDamage(tank: Tank, damage: number): number {
  const rounded = Math.max(0, Math.round(damage));
  tank.hp = Math.max(0, tank.hp - rounded);
  tank.hitFlash = 0.35;
  return rounded;
}

function splashDamage(tank: Tank, centerX: number, centerY: number, config: GameConfig): number {
  const radius = config.combat.explosionRadius;
  const d = Math.hypot(tank.x - centerX, tank.y - centerY);
  if (d > radius) return 0;
  const t = clamp(d / radius, 0, 1);
  return lerp(config.combat.directHitDamage, config.combat.splashMinDamage, t);
}

/** 命中结算：直接命中全额，波及按距离从全额线性衰减到最小值。 */
export function resolveDamage(
  hit: Hit,
  tanks: Record<PlayerId, Tank>,
  config: GameConfig,
): DamageResult[] {
  if (hit.kind === 'out') return [];
  const results: DamageResult[] = [];
  const directId = (hit.targetId ?? null) as PlayerId | null;

  if (hit.kind === 'tank' && directId) {
    const direct = tanks[directId];
    if (direct?.alive) {
      const damage = applyDamage(direct, config.combat.directHitDamage);
      results.push({ targetId: directId, damage, hp: direct.hp, direct: true });
    }
  }

  for (const id of PLAYER_IDS) {
    if (id === directId) continue;
    const tank = tanks[id];
    if (!tank.alive) continue;
    const damage = splashDamage(tank, hit.point.x, hit.point.y, config);
    if (damage <= 0) continue;
    const applied = applyDamage(tank, damage);
    results.push({ targetId: id, damage: applied, hp: tank.hp, direct: false });
  }

  return results;
}
