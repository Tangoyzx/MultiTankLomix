import { CONFIG } from '../config.js';
import { Emitter } from '../core/events.js';
import { otherPlayer, PLAYER_IDS, playerLabel } from '../core/types.js';
import type { PlayerId, Vec2 } from '../core/types.js';
import { Explosion } from '../entities/Explosion.js';
import { Projectile } from '../entities/Projectile.js';
import { advance, createState, previewPath } from './Ballistics.js';
import type { BallisticsContext, Hit, PreviewPath } from './Ballistics.js';
import { AimController } from './AimController.js';
import type { BattleState } from './BattleState.js';
import { resolveDamage } from './DamageResolver.js';
import type { DamageResult } from './DamageResolver.js';
import { MoveController } from './MoveController.js';
import type { MoveDir } from './MoveController.js';

export type TurnPhase = 'turnStart' | 'move' | 'aim' | 'resolving' | 'impact' | 'gameOver';

/** 远端对局里每回合结束发给对手的权威摘要，用来兜住浮点累积造成的漂移。 */
export interface TurnSnapshot {
  playerId: PlayerId;
  hp: number;
  x: number;
  y: number;
  /** 车体贴合地形后的倾角（弧度），远端校正后画面不会歪。 */
  rotation: number;
  windLevel: number;
}

export type TurnEvents = {
  turnStart: { playerId: PlayerId; wind: number };
  phase: { phase: TurnPhase; playerId: PlayerId };
  cameraFocus: { playerId: PlayerId };
  cameraFrameBoth: Record<string, never>;
  cameraFollow: Record<string, never>;
  shot: { playerId: PlayerId; angleDeg: number; power: number; dirSign: 1 | -1; origin: Vec2 };
  impact: { hit: Hit; results: DamageResult[] };
  moveCommitted: { playerId: PlayerId; dir: -1 | 1; distance: number };
  turnEnd: TurnSnapshot;
  gameOver: { winner: PlayerId };
};

export class TurnController {
  readonly events = new Emitter<TurnEvents>();
  readonly aim = new AimController();
  readonly move = new MoveController();
  phase: TurnPhase = 'turnStart';
  winner: PlayerId | null = null;
  /** 远端模式下，对手回合为 true：屏蔽本地输入但照常播放对方操作。 */
  inputLocked = false;

  private pendingMoveDistance = 0;
  private pendingMoveDir: -1 | 1 = 1;
  private impactTimer = 0;

  private readonly state: BattleState;

  constructor(state: BattleState) {
    this.state = state;
  }

  start(): void {
    this.beginTurn('left');
  }

  get acceptsInput(): boolean {
    if (this.phase === 'gameOver') return false;
    return !this.inputLocked;
  }

  get canMove(): boolean {
    return this.acceptsInput && this.phase === 'move';
  }

  get canAim(): boolean {
    return this.acceptsInput && (this.phase === 'move' || this.phase === 'aim');
  }

  get preview(): PreviewPath | null {
    if (this.phase !== 'aim') return null;
    const tank = this.state.activeTank;
    if (this.aim.state.power <= 0) return null;
    const velocity = this.aim.velocity(tank);
    const ctx = this.buildContext(0);
    const { maxSeconds, sampleEverySteps, maxPoints } = CONFIG.input.trail;
    return previewPath(tank.muzzle(), velocity, ctx, maxSeconds, sampleEverySteps, maxPoints);
  }

  private setPhase(phase: TurnPhase): void {
    this.phase = phase;
    this.events.emit('phase', { phase, playerId: this.state.activePlayerId });
  }

  beginTurn(playerId: PlayerId): void {
    const tank = this.state.tanks[playerId];
    this.state.activePlayerId = playerId;
    this.state.turnCount += 1;
    this.state.projectile = null;
    tank.movePointsLeft = tank.maxMovePoints;
    tank.aiming = false;
    this.move.reset();
    this.aim.reset();
    this.pendingMoveDistance = 0;
    this.state.world.wind.reroll(this.state.rng);
    this.setPhase('move');
    this.events.emit('turnStart', { playerId, wind: this.state.world.wind.level });
    this.events.emit('cameraFocus', { playerId });
  }

  /** 回合切换时把上一回合的权威状态交给上层，远端会发给对手做校正。 */
  private snapshotOf(playerId: PlayerId): TurnSnapshot {
    const tank = this.state.tanks[playerId];
    return {
      playerId,
      hp: tank.hp,
      x: tank.x,
      y: tank.y,
      rotation: tank.rotation,
      windLevel: this.state.world.wind.level,
    };
  }

  /** 远端校正：只改非本方（当前不操作）的坦克与风向，不打断本方动画。 */
  applySync(snapshot: TurnSnapshot): void {
    if (!snapshot || this.state.activePlayerId === snapshot.playerId) return;
    const tank = this.state.tanks[snapshot.playerId];
    if (!tank) return;
    if (Number.isFinite(snapshot.hp)) tank.hp = snapshot.hp;
    if (Number.isFinite(snapshot.x) && Number.isFinite(snapshot.y)) {
      tank.x = snapshot.x;
      tank.y = snapshot.y;
      tank.syncToGround(this.state.world.terrain);
      tank.rotation = snapshot.rotation;
    }
    if (Number.isFinite(snapshot.rotation)) tank.rotation = snapshot.rotation;
    if (Number.isFinite(snapshot.windLevel)) this.state.world.wind.level = snapshot.windLevel;
  }

  setMoveDirection(dir: MoveDir): void {
    if (!this.canMove) {
      this.move.dir = 0;
      return;
    }
    if (dir !== 0 && this.move.dir === 0) {
      this.pendingMoveDistance = 0;
      this.pendingMoveDir = dir;
    }
    this.move.dir = dir;
    if (dir === 0 && this.pendingMoveDistance >= 1) {
      this.events.emit('moveCommitted', {
        playerId: this.state.activePlayerId,
        dir: this.pendingMoveDir,
        distance: this.pendingMoveDistance,
      });
      this.pendingMoveDistance = 0;
    }
  }

  beginAim(): boolean {
    if (!this.canAim) return false;
    const tank = this.state.activeTank;
    this.aim.begin(tank);
    tank.aiming = true;
    this.setPhase('aim');
    this.events.emit('cameraFrameBoth', {});
    return true;
  }

  updateAim(pointerWorld: Vec2, dragPixels: number): void {
    if (this.phase !== 'aim') return;
    this.aim.update(this.state.activeTank, pointerWorld, dragPixels);
  }

  releaseAim(): void {
    if (this.phase !== 'aim') return;
    const tank = this.state.activeTank;
    if (this.aim.state.power < CONFIG.input.cancelPowerThreshold) {
      this.aim.reset();
      tank.aiming = false;
      this.setPhase('move');
      this.events.emit('cameraFocus', { playerId: tank.id });
      return;
    }
    this.fire();
  }

  private fire(): void {
    const tank = this.state.activeTank;
    const origin = tank.muzzle();
    const velocity = this.aim.velocity(tank);
    this.state.projectile = new Projectile(createState(origin, velocity));
    this.setPhase('resolving');
    this.events.emit('shot', {
      playerId: tank.id,
      angleDeg: this.aim.state.angleDeg,
      power: this.aim.state.power,
      dirSign: this.aim.state.dirSign,
      origin,
    });
    this.events.emit('cameraFollow', {});
  }

  /** 远端回放：对手的移动指令。 */
  applyRemoteMove(dir: -1 | 1, distance: number): void {
    if (this.phase !== 'move') return;
    this.move.queueRemote(dir, distance);
  }

  /** 远端回放：对手的发射指令。 */
  applyRemoteShot(angleDeg: number, power: number, dirSign: 1 | -1): void {
    if (this.phase !== 'move' && this.phase !== 'aim') return;
    const tank = this.state.activeTank;
    this.aim.begin(tank);
    this.aim.state.angleDeg = angleDeg;
    this.aim.state.power = power;
    this.aim.state.dirSign = dirSign;
    tank.aiming = true;
    tank.aimAngleDeg = angleDeg;
    tank.aimPower = power;
    tank.aimDirSign = dirSign;
    this.fire();
  }

  update(dt: number): void {
    const state = this.state;
    for (const id of PLAYER_IDS) state.tanks[id].update(dt);
    state.updateEffects(dt);

    if (this.phase === 'move') {
      const moved = this.move.update(dt, state.activeTank, state.opponentTank, state.world.terrain);
      this.pendingMoveDistance += moved;
    }

    if (this.phase === 'resolving' && state.projectile) {
      const hit = advance(state.projectile.state, dt, this.buildContext(state.world.wind.acceleration));
      state.projectile.recordTrail(dt);
      if (hit) this.resolveHit(hit);
    }

    if (this.phase === 'impact') {
      this.impactTimer -= dt;
      if (this.impactTimer <= 0 && state.explosions.length === 0) {
        const previous = state.activePlayerId;
        // 先把这一回合的权威结果发出去，再换人：远端拿到后校正对手侧的血量/位置。
        this.events.emit('turnEnd', this.snapshotOf(previous));
        this.beginTurn(otherPlayer(previous));
      }
    }
  }

  private buildContext(windAccel: number): BallisticsContext {
    const world = this.state.world;
    return {
      gravity: CONFIG.physics.gravity,
      windAccel,
      subStep: CONFIG.physics.projectileSubStep,
      airDrag: CONFIG.physics.airDrag,
      killBounds: world.derived.killBounds,
      terrain: world.terrain,
      targets: this.state.targets(),
      ignoreTargetId: this.state.activePlayerId,
      graceSeconds: CONFIG.combat.selfHitGraceSeconds,
    };
  }

  private resolveHit(hit: Hit): void {
    const results = resolveDamage(hit, this.state.tanks, CONFIG);
    if (hit.kind !== 'out') {
      this.state.explosions.push(
        new Explosion(hit.point.x, hit.point.y, CONFIG, () => this.state.fxRng.next()),
      );
    }
    for (const result of results) {
      const tank = this.state.tanks[result.targetId];
      this.state.addFloater(
        tank.x,
        tank.y - 46,
        `-${result.damage}`,
        result.direct ? '#ff8a5c' : '#ffd166',
      );
    }
    if (hit.kind === 'out') {
      this.state.addFloater(hit.point.x, hit.point.y, '出界', '#9fb3c8');
    }

    this.impactTimer = CONFIG.turn.impactHoldSeconds;
    this.setPhase('impact');
    this.events.emit('impact', { hit, results });

    const survivors = PLAYER_IDS.filter((id) => this.state.tanks[id].alive);
    if (survivors.length < 2) {
      const winner = survivors[0] ?? otherPlayer(this.state.activePlayerId);
      this.winner = winner;
      this.setPhase('gameOver');
      this.events.emit('gameOver', { winner });
    }
  }

  victoryText(): string {
    const winner = this.winner;
    if (!winner) return '';
    return `${playerLabel(winner)}胜利`;
  }
}
