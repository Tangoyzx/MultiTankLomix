/**
 * 输入总闸：本地操作只有在“自己可操作”时才放行。
 * 远端模式下对手回合会置 locked，本地的点击与按钮全部失效，但回放照常播放。
 */
export class InputGate {
  private locked = false;
  private uiBlocked = false;
  private readonly provider: () => boolean;

  constructor(provider: () => boolean) {
    this.provider = provider;
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** 弹窗/菜单打开时屏蔽战场输入。 */
  setUiBlocked(blocked: boolean): void {
    this.uiBlocked = blocked;
  }

  get canControl(): boolean {
    return !this.locked && !this.uiBlocked && this.provider();
  }

  get blockedReason(): 'locked' | 'ui' | 'phase' | null {
    if (this.locked) return 'locked';
    if (this.uiBlocked) return 'ui';
    if (!this.provider()) return 'phase';
    return null;
  }
}
