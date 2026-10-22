import { CONFIG, gameplayConfigHash } from '../config.js';
import { randomSeed } from '../core/rng.js';
import { otherPlayer, PLAYER_IDS } from '../core/types.js';
import type { PlayerId, Vec2 } from '../core/types.js';
import { InputGate } from '../input/InputGate.js';
import { PointerInput } from '../input/PointerInput.js';
import { BroadcastTransport } from '../net/BroadcastTransport.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { RemoteTransport } from '../net/RemoteTransport.js';
import type { GameCommand, Transport } from '../net/Transport.js';
import { assertConfigMatch } from '../net/Transport.js';
import { Camera } from '../render/Camera.js';
import type { Box } from '../render/Camera.js';
import { Renderer } from '../render/Renderer.js';
import { HudOverlay } from '../ui/dom/HudOverlay.js';
import type { HudData, HudTankInfo } from '../ui/dom/HudOverlay.js';
import { MainMenu } from '../ui/dom/MainMenu.js';
import { ResultDialog } from '../ui/dom/ResultDialog.js';
import { TankSelect } from '../ui/dom/TankSelect.js';
import type { TankPicks } from '../ui/dom/TankSelect.js';
import { showToast } from '../ui/dom/dom.js';
import { BattleState } from './BattleState.js';
import type { MoveDir } from './MoveController.js';
import { TurnController } from './TurnController.js';

export type AppScreen = 'menu' | 'select' | 'battle' | 'result';
export type PlayMode = 'local' | 'remote';

const REMOTE_ENDPOINT_PLACEHOLDER = 'wss://尚未接入';

/**
 * 应用外壳：菜单 → 选坦 → 战斗 → 结算 的状态机，
 * 固定步长推进模拟（渲染帧率无关），并把镜头意图翻译成相机动作。
 */
export class GameApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly camera = new Camera();
  private readonly renderer: Renderer;
  private readonly gate: InputGate;
  private readonly pointer: PointerInput;
  private readonly hud: HudOverlay;
  private readonly menu: MainMenu;
  private readonly select: TankSelect;
  private readonly dialog: ResultDialog;

  private screen: AppScreen = 'menu';
  private state: BattleState | null = null;
  private turn: TurnController | null = null;
  private transport: Transport | null = null;
  private lastImpact: Vec2 | null = null;
  private resultTimer = -1;
  private pendingWinner: PlayerId | null = null;

  private mode: PlayMode = 'local';
  private seat: PlayerId = 'left';
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.ctx = ctx;
    this.renderer = new Renderer(ctx, this.camera);

    this.gate = new InputGate(() => this.turn?.acceptsInput === true);
    this.pointer = new PointerInput(canvas, this.camera, {
      canControl: () => this.gate.canControl,
      activeTankScreen: () => this.activeTankScreen(),
      activeAimPivotScreen: () => this.activeAimPivotScreen(),
      activeTankWorld: () => this.activeTankWorld(),
      onAimStart: () => this.turn?.beginAim() ?? false,
      onAimMove: (world, dragPixels) => this.turn?.updateAim(world, dragPixels),
      onAimEnd: () => this.turn?.releaseAim(),
    });

    this.menu = new MainMenu({ onLocal: () => this.openSelect() });
    this.select = new TankSelect({
      onPickChange: (playerId, tankId) => this.sendPick(playerId, tankId),
      onConfirm: (picks) => this.confirmPicks(picks),
      onBack: () => this.showMenu(),
    });
    this.dialog = new ResultDialog({ onConfirm: () => this.showMenu() });
    this.hud = new HudOverlay({
      onMove: (dir: MoveDir) => this.onMove(dir),
      onExit: () => this.showMenu(),
    });

    uiRoot.append(this.menu.root, this.select.root, this.hud.root, this.dialog.root);
    this.readUrlMode();
    this.hud.setVisible(false);
    this.select.setVisible(false);
    this.dialog.hide();

    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', this.resize);
  }

  start(): void {
    this.screen = 'menu';
    this.gate.setUiBlocked(true);
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readUrlMode(): void {
    const params = new URLSearchParams(window.location.search);
    this.mode = params.get('mode') === 'remote' ? 'remote' : 'local';
    this.seat = params.get('seat') === 'right' ? 'right' : 'left';
  }

  private createTransport(): Transport {
    const params = new URLSearchParams(window.location.search);
    if (this.mode === 'local') return new LocalTransport();
    const net = params.get('net') ?? 'remote';
    if (net === 'broadcast') {
      return new BroadcastTransport(params.get('room') ?? 'default');
    }
    return new RemoteTransport(REMOTE_ENDPOINT_PLACEHOLDER);
  }

  private openSelect(): void {
    this.screen = 'select';
    this.gate.setUiBlocked(true);
    this.menu.setVisible(false);
    this.hud.setVisible(false);
    this.select.setVisible(true);
    this.select.setLockedSeat(this.mode === 'remote' ? otherPlayer(this.seat) : null);

    this.transport?.close();
    this.transport = this.createTransport();
    if (this.mode === 'remote') {
      this.transport.events.on('command', (command) => this.onRemoteCommand(command));
      try {
        this.transport.connect();
        this.transport.send({
          type: 'handshake',
          playerId: this.seat,
          configHash: gameplayConfigHash(),
        });
      } catch (error) {
        showToast(this.uiRoot, error instanceof Error ? error.message : '远端连接失败');
        this.showMenu();
      }
    } else {
      this.transport.connect();
    }
  }

  /** 远端：把自己的选择同步给对方，让两边最终拿到相同的 picks。 */
  private sendPick(playerId: PlayerId, tankId: string): void {
    if (this.mode !== 'remote' || !this.transport) return;
    this.transport.send({ type: 'pick', playerId, tankId });
  }

  private confirmPicks(picks: TankPicks): void {
    const seed = this.urlSeed() ?? randomSeed();
    if (this.mode === 'remote' && this.transport) {
      this.transport.send({ type: 'start', seed, picks });
    }
    this.startBattle(seed, picks);
  }

  /** 调试用：URL 里带 ?seed=123 时固定地形种子，方便复现同一张地图。 */
  private urlSeed(): number | null {
    const raw = new URLSearchParams(window.location.search).get('seed');
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  private startBattle(seed: number, picks: TankPicks): void {
    this.disposeBattle();
    this.state = new BattleState(seed, picks);
    this.turn = new TurnController(this.state);
    this.lastImpact = null;
    this.resultTimer = -1;
    this.pendingWinner = null;
    this.wireTurn();
    this.turn.start();
    this.syncRemoteLock();
    this.camera.snap();

    this.screen = 'battle';
    this.gate.setUiBlocked(false);
    this.menu.setVisible(false);
    this.select.setVisible(false);
    this.dialog.hide();
    this.hud.setVisible(true);
  }

  private wireTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.events.on('cameraFocus', ({ playerId }) => {
      if (!this.state) return;
      const tank = this.state.tanks[playerId];
      this.camera.focusOn(tank.x, tank.y);
    });
    turn.events.on('cameraFrameBoth', () => {
      this.frameAimCamera();
    });
    turn.events.on('moveCommitted', ({ playerId, dir, distance }) => {
      this.transport?.send({ type: 'move', playerId, dir, distance });
    });
    turn.events.on('shot', ({ playerId, angleDeg, power, dirSign }) => {
      this.transport?.send({ type: 'shot', playerId, angleDeg, power, dirSign });
    });
    turn.events.on('impact', ({ hit }) => {
      this.lastImpact = { x: hit.point.x, y: hit.point.y };
    });
    turn.events.on('gameOver', ({ winner }) => {
      this.pendingWinner = winner;
      this.resultTimer = CONFIG.ui.resultDelaySeconds;
    });
  }

  /** 远端：只回放对方的操作；本地输入在 inputLocked 时被 gate 拦截。 */
  private onRemoteCommand(command: GameCommand): void {
    switch (command.type) {
      case 'handshake':
        try {
          assertConfigMatch(gameplayConfigHash(), command.configHash);
        } catch (error) {
          showToast(this.uiRoot, error instanceof Error ? error.message : '配置不一致');
          this.showMenu();
        }
        break;
      case 'move':
        this.turn?.applyRemoteMove(command.dir, command.distance);
        break;
      case 'shot':
        this.turn?.applyRemoteShot(command.angleDeg, command.power, command.dirSign);
        break;
      case 'start':
        if (this.screen === 'select') {
          // 对方的选择以对方发来的为准，自己的席位用本地选择，保证两边一致。
          const merged: TankPicks = { ...command.picks, [this.seat]: this.select.getPicks()[this.seat] };
          this.startBattle(command.seed, merged);
        }
        break;
      case 'pick':
        this.select.setPick(command.playerId, command.tankId);
        break;
      default:
        break;
    }
  }

  private onMove(dir: MoveDir): void {
    if (!this.turn) return;
    if (dir !== 0 && !this.gate.canControl) {
      this.turn.setMoveDirection(0);
      return;
    }
    this.turn.setMoveDirection(dir);
  }

  private showMenu(): void {
    this.disposeBattle();
    this.screen = 'menu';
    this.gate.setUiBlocked(true);
    this.menu.setVisible(true);
    this.select.setVisible(false);
    this.hud.setVisible(false);
    this.dialog.hide();
    this.transport?.close();
    this.transport = null;
  }

  private disposeBattle(): void {
    this.turn?.events.clear();
    this.turn = null;
    this.state = null;
    this.lastImpact = null;
  }

  private activeTankScreen(): Vec2 | null {
    if (!this.state) return null;
    const tank = this.state.activeTank;
    return this.camera.worldToScreen(tank.x, tank.y);
  }

  private activeTankWorld(): Vec2 | null {
    if (!this.state) return null;
    const tank = this.state.activeTank;
    return { x: tank.x, y: tank.y };
  }

  private activeAimPivotScreen(): Vec2 | null {
    if (!this.state) return null;
    const pivot = this.state.activeTank.aimPivot();
    return this.camera.worldToScreen(pivot.x, pivot.y);
  }

  private bothTanksBox(): Box {
    const empty: Box = { minX: 0, minY: 0, maxX: CONFIG.world.width, maxY: CONFIG.world.height };
    if (!this.state) return empty;
    const { left, right } = this.state.tanks;
    return {
      minX: Math.min(left.x, right.x),
      maxX: Math.max(left.x, right.x),
      minY: Math.min(left.y, right.y),
      maxY: Math.max(left.y, right.y),
    };
  }

  /** 瞄准取景：镜头以自己炮塔为参照，力度圆整圆可见，同时对手留在画面内。 */
  private frameAimCamera(): void {
    const state = this.state;
    if (!state) return;
    const self = state.activeTank;
    const opponent = state.tanks[otherPlayer(state.activePlayerId)];
    this.applyAimRadius();
    this.camera.frameAim(self.aimPivot(), { x: opponent.x, y: opponent.y }, this.renderer.aimRadiusPx);
  }

  /** 力度圆半径随视口变化，渲染与力度归一化必须用同一个值。 */
  private applyAimRadius(): void {
    this.turn?.aim.setMaxDragPixels(this.renderer.aimRadiusPx);
  }

  private readonly resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.renderer.resize(width, height, dpr);
    this.updateCameraTarget();
    this.camera.snap();
  };

  private readonly frame = (timeMs: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const dt = Math.max(0, (timeMs - this.lastTime) / 1000);
    this.lastTime = timeMs;

    this.accumulator += Math.min(dt, CONFIG.sim.maxFrameSeconds);
    const step = CONFIG.sim.fixedStep;
    let steps = 0;
    while (this.accumulator >= step && steps < CONFIG.sim.maxCatchUpSteps) {
      this.stepSim(step);
      this.accumulator -= step;
      steps++;
    }
    if (steps === CONFIG.sim.maxCatchUpSteps) this.accumulator = 0;

    this.updateCameraTarget();
    this.camera.update(dt);
    this.draw(dt);
  };

  private stepSim(dt: number): void {
    const turn = this.turn;
    if (!turn) return;
    turn.update(dt);
    this.syncRemoteLock();

    if (this.resultTimer > 0) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0) this.openResult();
    }
  }

  /** 远端模式：只在轮到自己时开放本地输入，对局一开始就要生效，不留可操作的第一帧。 */
  private syncRemoteLock(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.inputLocked = this.mode === 'remote' && this.state?.activePlayerId !== this.seat;
  }

  /** 各阶段的镜头意图：移动跟随、瞄准框住双方、飞行与结算包含弹着点。 */
  private updateCameraTarget(): void {
    if (!this.state || !this.turn) return;
    this.applyAimRadius();
    const phase = this.turn.phase;
    if (phase === 'move' || phase === 'turnStart') {
      const tank = this.state.activeTank;
      this.camera.focusOn(tank.x, tank.y);
      return;
    }
    if (phase === 'aim') {
      this.frameAimCamera();
      return;
    }
    if (phase === 'resolving' || phase === 'impact') {
      const box = this.bothTanksBox();
      const point = this.state.projectile?.position ?? this.lastImpact;
      if (point) {
        box.minX = Math.min(box.minX, point.x);
        box.maxX = Math.max(box.maxX, point.x);
        box.minY = Math.min(box.minY, point.y);
        box.maxY = Math.max(box.maxY, point.y);
      }
      this.camera.frameBox(box);
    }
  }

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!this.state || !this.turn) {
      ctx.setTransform(this.renderer.dpr, 0, 0, this.renderer.dpr, 0, 0);
      ctx.clearRect(0, 0, this.renderer.cssWidth, this.renderer.cssHeight);
      return;
    }
    this.renderer.render(
      this.state,
      {
        activePlayerId: this.state.activePlayerId,
        preview: this.turn.preview,
        aimScreen: this.pointer.aimHint,
        locked: this.turn.inputLocked,
      },
      dt,
    );
    this.updateHud();
  }

  private updateHud(): void {
    const state = this.state;
    const turn = this.turn;
    if (!state || !turn) return;
    const tanks = {} as Record<PlayerId, HudTankInfo>;
    for (const id of PLAYER_IDS) {
      const tank = state.tanks[id];
      tanks[id] = {
        typeName: tank.type.name,
        hp: tank.hp,
        maxHp: tank.maxHp,
        moveLeft: tank.movePointsLeft,
        moveMax: tank.maxMovePoints,
      };
    }
    const data: HudData = {
      activePlayerId: state.activePlayerId,
      phase: turn.phase,
      windLevel: state.world.wind.level,
      tanks,
      angleDeg: turn.aim.state.angleDeg,
      power: turn.aim.state.power,
      locked: turn.inputLocked,
      hint: this.hintText(turn),
      blocked: this.blockedDirections(turn),
    };
    this.hud.update(data);
    this.hud.setControlsEnabled(turn.canMove && this.gate.canControl);
  }

  /** 移动阶段里，前方过陡的方向（用于把按钮置灰并给出提示）。 */
  private blockedDirections(turn: TurnController): { left: boolean; right: boolean } {
    const none = { left: false, right: false };
    const state = this.state;
    if (!state || !turn.canMove) return none;
    const tank = state.activeTank;
    if (tank.movePointsLeft <= 0) return none;
    const terrain = state.world.terrain;
    return {
      left: turn.move.isBlocked(-1, tank, terrain),
      right: turn.move.isBlocked(1, tank, terrain),
    };
  }
  private hintText(turn: TurnController): string {
    if (turn.inputLocked) return '对方回合，正在接收对方操作…';
    switch (turn.phase) {
      case 'move':
        return '左右按钮移动；按住自己的坦克向反方向拖拽进入射击';
      case 'aim':
        return '虚线是无风弹道预览，松手开火';
      case 'resolving':
        return '炮弹飞行中，风力与重力正在生效';
      case 'impact':
        return '结算中…';
      default:
        return '';
    }
  }

  private openResult(): void {
    const state = this.state;
    const winner = this.pendingWinner;
    if (!state || !winner) return;
    this.resultTimer = -1;
    this.screen = 'result';
    this.gate.setUiBlocked(true);
    const survivorHp = Math.ceil(state.tanks[winner].hp);
    this.dialog.show(
      `${winner === 'left' ? '左边玩家' : '右边玩家'}胜利`,
      `共 ${state.turnCount} 回合 · 剩余生命 ${survivorHp}`,
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('orientationchange', this.resize);
    this.pointer.dispose();
    this.hud.dispose();
    this.transport?.close();
  }
}
