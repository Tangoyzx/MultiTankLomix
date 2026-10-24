import { CONFIG } from '../../config.js';
import { el, setVisible } from './dom.js';

export interface MainMenuHandlers {
  onLocal: () => void;
  onRemote: () => void;
}

/** 主界面：本地双人与远端快速匹配两个入口。 */
export class MainMenu {
  readonly root: HTMLElement;
  private readonly versionLine: HTMLElement;

  constructor(handlers: MainMenuHandlers, version = 'dev') {
    this.root = el('div', 'screen menu');

    const title = el('h1', 'menu-title', '双人坦克大战');
    const subtitle = el(
      'p',
      'menu-subtitle',
      '回合制炮击对决 · 本地双人 / 远端快速匹配',
    );

    const localButton = el('button', 'primary-button', '本地双人游玩');
    localButton.type = 'button';
    localButton.addEventListener('click', handlers.onLocal);

    const remoteButton = el('button', 'primary-button', '远端对战（快速匹配）');
    remoteButton.type = 'button';
    remoteButton.classList.add('remote-button');
    remoteButton.addEventListener('click', handlers.onRemote);

    const hints = el(
      'p',
      'menu-hint',
      `操作：下方按钮控制左右移动，按住自己的坦克向反方向拖拽蓄力，松手开火。地图 ${CONFIG.world.width}×${CONFIG.world.height}。远端对战会与另一台设备上的玩家自动配对。`,
    );

    // 页脚版本：玩家一眼能确认自己加载的是哪一次构建。
    this.versionLine = el('p', 'menu-version', `版本 ${version}`);

    this.root.append(title, subtitle, localButton, remoteButton, hints, this.versionLine);
  }

  setVersion(text: string): void {
    this.versionLine.textContent = `版本 ${text}`;
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }
}
