import type { TankTypeConfig } from '../../config.js';
import { PLAYER_IDS, playerLabel } from '../../core/types.js';
import type { PlayerId } from '../../core/types.js';
import { allTankTypes, DEFAULT_TANK_ID } from '../../game/TankTypes.js';
import { tankColors } from '../../render/palette.js';
import { drawTankIcon } from '../../render/tankIcon.js';
import { button, el, setVisible } from './dom.js';

export type TankPicks = Record<PlayerId, string>;

export interface TankSelectHandlers {
  onPickChange: (playerId: PlayerId, tankId: string) => void;
  onConfirm: (picks: TankPicks) => void;
  onBack: () => void;
}

/** 双方选坦：同屏两个面板，都选好后“下一步”才可点。 */
export class TankSelect {
  readonly root: HTMLElement;
  private picks: TankPicks = { left: DEFAULT_TANK_ID, right: DEFAULT_TANK_ID };
  private lockedSeat: PlayerId | null = null;
  private readonly nextButton: HTMLButtonElement;
  private readonly panels = new Map<PlayerId, HTMLElement>();
  private readonly handlers: TankSelectHandlers;

  constructor(handlers: TankSelectHandlers) {
    this.handlers = handlers;
    this.root = el('div', 'screen select');

    const title = el('h2', 'screen-title', '选择坦克');
    const tip = el('p', 'screen-tip', '两名玩家各自选择一款坦克，选好后点“下一步”');
    const panels = el('div', 'select-panels');
    for (const id of PLAYER_IDS) {
      panels.appendChild(this.buildPanel(id));
    }

    const actions = el('div', 'select-actions');
    actions.appendChild(button('返回', 'ghost-button', handlers.onBack));
    this.nextButton = button('下一步', 'primary-button', () => handlers.onConfirm(this.picks));
    this.nextButton.classList.add('next-button');
    actions.appendChild(this.nextButton);

    this.root.append(title, tip, panels, actions);
    this.refresh();
  }

  private buildPanel(playerId: PlayerId): HTMLElement {
    const panel = el('div', `panel panel-${playerId}`);
    const colors = tankColors(playerId);
    panel.style.setProperty('--panel-color', colors.body);
    panel.appendChild(el('h3', 'panel-title', playerLabel(playerId)));

    const cards = el('div', 'cards');
    for (const type of allTankTypes()) {
      cards.appendChild(this.buildCard(playerId, type));
    }
    panel.appendChild(cards);
    this.panels.set(playerId, panel);
    return panel;
  }

  private buildCard(playerId: PlayerId, type: TankTypeConfig): HTMLElement {
    const colors = tankColors(playerId);
    const card = el('div', 'card');
    card.dataset.tankId = type.id;
    card.dataset.playerId = playerId;

    const canvas = el('canvas', 'card-icon');
    canvas.width = 120;
    canvas.height = 80;
    card.appendChild(canvas);
    window.setTimeout(() => drawTankIcon(canvas, type, colors.body, colors.dark), 0);

    card.appendChild(el('div', 'card-name', type.name));
    card.appendChild(el('div', 'card-blurb', type.blurb));

    const stats = el('dl', 'card-stats');
    const rows: [string, string][] = [
      ['生命', `${type.hp}`],
      ['移动力', `${type.movePoints}`],
      ['射界', `${type.minAngleDeg}° ~ ${type.maxAngleDeg}°`],
      ['最大力度', `${type.maxLaunchSpeed}`],
      ['破坏半径', `${type.terrainDamageRadius}（备用）`],
    ];
    for (const [key, value] of rows) {
      const row = el('div', 'stat-row');
      row.appendChild(el('dt', undefined, key));
      row.appendChild(el('dd', undefined, value));
      stats.appendChild(row);
    }
    card.appendChild(stats);

    card.addEventListener('click', () => {
      if (this.lockedSeat === playerId) return;
      if (this.picks[playerId] === type.id) return;
      this.picks = { ...this.picks, [playerId]: type.id };
      this.refresh();
      this.handlers.onPickChange(playerId, type.id);
    });

    return card;
  }

  /** 远端模式：锁定对方席位，只能选自己的坦克。 */
  setLockedSeat(seat: PlayerId | null): void {
    this.lockedSeat = seat;
    this.refresh();
  }

  setPick(playerId: PlayerId, tankId: string): void {
    if (this.picks[playerId] === tankId) return;
    this.picks = { ...this.picks, [playerId]: tankId };
    this.refresh();
  }

  getPicks(): TankPicks {
    return { ...this.picks };
  }

  private refresh(): void {
    for (const [playerId, panel] of this.panels) {
      const locked = this.lockedSeat === playerId;
      panel.classList.toggle('panel-locked', locked);
      for (const card of Array.from(panel.querySelectorAll<HTMLElement>('.card'))) {
        const selected = card.dataset.tankId === this.picks[playerId];
        card.classList.toggle('selected', selected);
        card.classList.toggle('card-locked', locked);
      }
    }
    this.nextButton.disabled = !PLAYER_IDS.every((id) => Boolean(this.picks[id]));
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }
}
