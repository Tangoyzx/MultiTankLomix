import { CONFIG } from '../../config.js';
import { PLAYER_IDS, playerLabel } from '../../core/types.js';
import type { PlayerId } from '../../core/types.js';
import type { MoveDir } from '../../game/MoveController.js';
import type { TurnPhase } from '../../game/TurnController.js';
import { el, setVisible } from './dom.js';

export interface HudTankInfo {
  typeName: string;
  hp: number;
  maxHp: number;
  moveLeft: number;
  moveMax: number;
}

export interface HudData {
  activePlayerId: PlayerId;
  phase: TurnPhase;
  windLevel: number;
  tanks: Record<PlayerId, HudTankInfo>;
  angleDeg: number;
  power: number;
  locked: boolean;
  hint: string;
  /** 该方向前方过陡，按钮置灰提示。 */
  blocked: { left: boolean; right: boolean };
}

export interface HudHandlers {
  onMove: (dir: MoveDir) => void;
  onExit: () => void;
}

const PHASE_TEXT: Record<TurnPhase, string> = {
  turnStart: '准备',
  move: '移动阶段',
  aim: '瞄准阶段',
  resolving: '炮弹飞行',
  impact: '结算中',
  gameOver: '对局结束',
};

/** 战斗界面 HUD：回合、风力、血量、移动按钮与瞄准读数。 */
export class HudOverlay {
  readonly root: HTMLElement;
  private readonly handlers: HudHandlers;
  private readonly turnChip: HTMLElement;
  private readonly phaseChip: HTMLElement;
  private readonly windChip: HTMLElement;
  private readonly hintLine: HTMLElement;
  private readonly aimReadout: HTMLElement;
  private readonly hpFills = new Map<PlayerId, HTMLElement>();
  private readonly hpTexts = new Map<PlayerId, HTMLElement>();
  private readonly moveFill: HTMLElement;
  private readonly moveText: HTMLElement;
  private readonly moveButtons = new Map<-1 | 1, HTMLButtonElement>();
  private readonly releaseHeld = (): void => this.handlers.onMove(0);

  constructor(handlers: HudHandlers) {
    this.handlers = handlers;
    this.root = el('div', 'hud');

    const top = el('div', 'hud-top');
    this.turnChip = el('div', 'chip chip-turn', '左边玩家回合');
    this.phaseChip = el('div', 'chip', '移动阶段');
    this.windChip = el('div', 'chip chip-wind', '风 · 0');
    const exit = el('button', 'chip chip-button', '退出');
    exit.type = 'button';
    exit.addEventListener('click', handlers.onExit);
    top.append(this.turnChip, this.phaseChip, this.windChip, exit);

    const hpRow = el('div', 'hud-hp');
    for (const id of PLAYER_IDS) {
      const block = el('div', `hp-block hp-${id}`);
      const label = el('span', 'hp-label', playerLabel(id));
      const track = el('div', 'hp-track');
      const fill = el('div', 'hp-fill');
      track.appendChild(fill);
      const text = el('span', 'hp-text', '100');
      block.append(label, track, text);
      hpRow.appendChild(block);
      this.hpFills.set(id, fill);
      this.hpTexts.set(id, text);
    }

    const bottom = el('div', 'hud-bottom');
    const pad = el('div', 'move-pad');
    pad.appendChild(this.buildMoveButton('left', -1));
    const meter = el('div', 'move-meter');
    this.moveFill = el('div', 'move-fill');
    meter.appendChild(this.moveFill);
    this.moveText = el('div', 'move-text', '移动力 0 / 0');
    const meterWrap = el('div', 'meter-wrap');
    meterWrap.append(this.moveText, meter);
    pad.appendChild(meterWrap);
    pad.appendChild(this.buildMoveButton('right', 1));

    this.aimReadout = el('div', 'aim-readout', '角度 — · 力度 0%');
    this.hintLine = el('div', 'hud-hint', '按住自己的坦克向反方向拖拽蓄力');
    bottom.append(pad, this.aimReadout, this.hintLine);

    this.root.append(top, hpRow, bottom);
    window.addEventListener('pointerup', this.releaseHeld);
    window.addEventListener('pointercancel', this.releaseHeld);
  }

  private buildMoveButton(side: 'left' | 'right', dir: MoveDir): HTMLButtonElement {
    const node = el('button', `move-button move-${side}`, side === 'left' ? '◀' : '▶');
    node.type = 'button';
    node.style.width = `${CONFIG.ui.moveButtonSizePx}px`;
    node.style.height = `${CONFIG.ui.moveButtonSizePx}px`;
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (node.disabled) return;
      this.handlers.onMove(dir);
    });
    node.addEventListener('contextmenu', (event) => event.preventDefault());
    this.moveButtons.set(dir as -1 | 1, node);
    return node;
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }

  update(data: HudData): void {
    this.turnChip.textContent = `${playerLabel(data.activePlayerId)}回合`;
    this.turnChip.classList.toggle('chip-left', data.activePlayerId === 'left');
    this.turnChip.classList.toggle('chip-right', data.activePlayerId === 'right');
    this.phaseChip.textContent = data.locked ? '等待对方操作' : PHASE_TEXT[data.phase];

    const abs = Math.abs(data.windLevel);
    const arrow = data.windLevel === 0 ? '·' : data.windLevel > 0 ? '→' : '←';
    this.windChip.textContent = `风 ${arrow} ${abs}`;
    this.windChip.classList.toggle('wind-strong', abs >= Math.ceil(CONFIG.wind.maxLevel / 2));

    for (const id of PLAYER_IDS) {
      const info = data.tanks[id];
      const fill = this.hpFills.get(id);
      const text = this.hpTexts.get(id);
      const ratio = info.maxHp > 0 ? Math.max(0, info.hp / info.maxHp) : 0;
      if (fill) {
        fill.style.width = `${ratio * 100}%`;
        fill.classList.toggle('low', ratio <= 0.35);
      }
      if (text) text.textContent = `${Math.ceil(info.hp)}`;
    }

    const active = data.tanks[data.activePlayerId];
    const moveRatio = active.moveMax > 0 ? active.moveLeft / active.moveMax : 0;
    this.moveFill.style.width = `${Math.max(0, Math.min(1, moveRatio)) * 100}%`;
    this.moveText.textContent = `移动力 ${Math.round(active.moveLeft)} / ${active.moveMax}`;

    const showAim = data.phase === 'aim';
    this.aimReadout.textContent = showAim
      ? `角度 ${data.angleDeg.toFixed(0)}° · 力度 ${Math.round(data.power * 100)}%`
      : `角度 — · 力度 0%`;

    const blockedRight = data.blocked?.right ?? false;
    const blockedLeft = data.blocked?.left ?? false;
    this.moveButtons.get(1)?.classList.toggle('is-blocked', blockedRight);
    this.moveButtons.get(-1)?.classList.toggle('is-blocked', blockedLeft);
    if (blockedRight || blockedLeft) {
      const side = blockedRight && blockedLeft ? '两侧' : blockedRight ? '右侧' : '左侧';
      this.hintLine.textContent = `${data.hint}（${side}坡度过陡，过不去）`;
      return;
    }

    this.hintLine.textContent = data.hint;
  }

  /** 远端对手回合或结算中：禁用移动按钮。 */
  setControlsEnabled(enabled: boolean): void {
    for (const node of this.moveButtons.values()) node.disabled = !enabled;
  }

  dispose(): void {
    window.removeEventListener('pointerup', this.releaseHeld);
    window.removeEventListener('pointercancel', this.releaseHeld);
  }
}
