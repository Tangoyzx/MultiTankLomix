import { button, el, setVisible } from './dom.js';

export type MatchStatus = 'connecting' | 'waiting' | 'matched' | 'error';

export interface MatchPanelHandlers {
  onCancel: () => void;
}

const STATUS_TEXT: Record<MatchStatus, string> = {
  connecting: '正在连接服务器…',
  waiting: '排队中，等待另一个玩家加入…',
  matched: '已匹配到对手，进入选坦…',
  error: '连接失败，请返回重试',
};

/** 快速匹配等待界面：连上服务器后只要再有一个人排队就会自动开局。 */
export class MatchPanel {
  readonly root: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly versionLine: HTMLElement;

  constructor(handlers: MatchPanelHandlers, version = 'dev') {
    this.root = el('div', 'screen match-screen');

    const title = el('h2', 'screen-title', '远端对战');
    const tip = el('p', 'screen-tip', '正在快速匹配：服务器会把排队的两名玩家自动配成一局');

    this.statusLine = el('p', 'match-status', STATUS_TEXT.connecting);
    const spinner = el('div', 'match-spinner');
    spinner.appendChild(el('span', 'match-dot'));
    spinner.appendChild(el('span', 'match-dot'));
    spinner.appendChild(el('span', 'match-dot'));

    this.versionLine = el('p', 'match-version', `版本 ${version}`);

    const actions = el('div', 'match-actions');
    actions.appendChild(button('取消', 'ghost-button', handlers.onCancel));

    this.root.append(title, tip, spinner, this.statusLine, actions, this.versionLine);
  }

  setStatus(status: MatchStatus, detail?: string): void {
    this.statusLine.textContent = detail ?? STATUS_TEXT[status];
    this.statusLine.dataset.status = status;
    this.root.classList.toggle('match-error', status === 'error');
  }

  setVersion(text: string): void {
    this.versionLine.textContent = `版本 ${text}`;
  }

  setVisible(visible: boolean): void {
    setVisible(this.root, visible);
  }
}
