import { button, el, setVisible } from './dom.js';

export interface ResultDialogHandlers {
  onConfirm: () => void;
}

/** 对局结束弹窗：显示“左边/右边玩家胜利”，确认后回主界面。 */
export class ResultDialog {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;

  constructor(handlers: ResultDialogHandlers) {
    this.root = el('div', 'screen result');
    const card = el('div', 'result-card');
    this.title = el('h2', 'result-title', '');
    this.detail = el('p', 'result-detail', '');
    card.append(this.title, this.detail, button('确认', 'primary-button', handlers.onConfirm));
    this.root.appendChild(card);
  }

  show(text: string, detail: string): void {
    this.title.textContent = text;
    this.detail.textContent = detail;
    setVisible(this.root, true);
  }

  hide(): void {
    setVisible(this.root, false);
  }
}
