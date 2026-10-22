/**
 * 自动化测试用的“瞄准机器人”：用与实弹完全相同的积分器暴力搜索命中解。
 * 找到解就能在无人操作的情况下真正打出一发命中弹，用来验证伤害与胜负流程。
 */
import { CONFIG, DERIVED } from '../dist/config.js';
import { advance, createState } from '../dist/game/Ballistics.js';

export function solveShot(state) {
  const shooter = state.activeTank;
  const target = state.opponentTank;
  const dirSign = target.x > shooter.x ? 1 : -1;
  const ctx = {
    gravity: CONFIG.physics.gravity,
    windAccel: state.world.wind.acceleration,
    subStep: CONFIG.physics.projectileSubStep,
    airDrag: CONFIG.physics.airDrag,
    killBounds: DERIVED.killBounds,
    terrain: state.world.terrain,
    targets: state.targets(),
    ignoreTargetId: state.activePlayerId,
    graceSeconds: CONFIG.combat.selfHitGraceSeconds,
  };

  // 真实开火时 tank.aiming=true，炮口位置随候选角度变化；
  // 这里必须按候选角度取炮口，否则模拟起点和实弹起点差出几像素，擦山脊时会脱靶。
  const prev = { aiming: shooter.aiming, angle: shooter.aimAngleDeg, dir: shooter.aimDirSign };
  const muzzleFor = (angle) => {
    shooter.aiming = true;
    shooter.aimAngleDeg = angle;
    shooter.aimDirSign = dirSign;
    return shooter.muzzle();
  };

  for (let angleDeg = shooter.type.minAngleDeg; angleDeg <= shooter.type.maxAngleDeg; angleDeg += 1) {
    for (let power = 0.15; power <= 1.0001; power += 0.01) {
      const speed = power * shooter.type.maxLaunchSpeed;
      const rad = (angleDeg * Math.PI) / 180;
      const velocity = { x: Math.cos(rad) * speed * dirSign, y: -Math.sin(rad) * speed };
      const sim = createState(muzzleFor(angleDeg), velocity);
      let hit = null;
      for (let i = 0; i < 400 && !hit; i++) hit = advance(sim, 1 / 60, ctx);
      if (hit?.kind === 'tank' && hit.targetId === target.id) return { angleDeg, power, dirSign };
    }
  }
  shooter.aiming = prev.aiming;
  shooter.aimAngleDeg = prev.angle;
  shooter.aimDirSign = prev.dir;
  return null;
}
