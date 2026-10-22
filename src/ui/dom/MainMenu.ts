import { CONFIG } from '../../config.js';
import { el, setVisible, showToast } from './dom.js';

export interface MainMenuHandlers {
  onLocal: () => void;
}

/** 主界面：本地双人可玩，远端多人按钮置灰不可点。 */
export class MainMenu {
  readonly root: HTMLElement;

  constructor(handlers: MainMenuHandlers) {
    this.root = el('div', 'screen menu');

    const title = el('h1', 'menu-title', '双人坦克大战');
    const subtitle = el(
      'p',
      'menu-subtitle',
      '回合制炮击对决 · 支持鼠标与触屏',
    );

    const localButton = el('button', 'primary-button', '本地双人游玩');
    localButton.type = 'button';
    localButton.addEventListener('click', handlers.onLocal);

    const remoteButton = el('button', 'primary-button', '远端多人游玩');
    remoteButton.type = 'button';
    remoteButton.disabled = true;
    remoteButton.classList.add('disabled-button');

    const remoteWrapper = el('div', 'remote-wrapper');
    remoteWrapper.appendChild(remoteButton);
    remoteWrapper.appendChild(el('span', 'remote-hint', '即将开放'));
    remoteWrapper.addEventListener('click', () => {
      showToast(this.root, '远端多人游玩即将开放，敬请期待');
    });

    const hints = el(
      'p',
      'menu-hint',
      `操作：下方按钮控制左右移动，按住自己的坦克向反方向拖拽蓄力，松手开火。地图 ${CONFIG.world.width}×${CONFIG.world.height}。`,
    );

    this.root.append(title, subtitle, localButton, remoteWrapper, hints);
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }
}
