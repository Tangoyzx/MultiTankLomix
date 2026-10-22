export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function setVisible(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

/** 轻量提示条，用于“远端即将开放”之类的反馈。 */
export function showToast(host: HTMLElement, text: string, durationMs = 1600): void {
  const toast = el('div', 'toast', text);
  host.appendChild(toast);
  window.setTimeout(() => toast.remove(), durationMs);
}

export function readUrlFlag(search: string, key: string): string | null {
  return new URLSearchParams(search).get(key);
}
