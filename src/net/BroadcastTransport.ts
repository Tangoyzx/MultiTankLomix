import { Emitter } from '../core/events.js';
import type { GameCommand, Transport, TransportEvents, TransportKind } from './Transport.js';

/**
 * 仅用于验证远端接口的同浏览器联调实现：用 BroadcastChannel 在两个标签页之间转发命令。
 * 走的是和 RemoteTransport 完全相同的接口，所以能验证：
 * 自己回合本地操作 → 发出命令；对方回合本地被锁 → 收到命令后本地回放。
 * 正式远端接入后这个类可以整体删除。
 */
export class BroadcastTransport implements Transport {
  readonly kind: TransportKind = 'broadcast';
  readonly events = new Emitter<TransportEvents>();
  private channel: BroadcastChannel | null = null;
  private readonly room: string;

  constructor(room: string) {
    this.room = room;
  }

  get available(): boolean {
    return typeof BroadcastChannel !== 'undefined';
  }

  connect(): void {
    if (!this.available) {
      this.events.emit('status', { state: 'error', detail: '当前浏览器不支持 BroadcastChannel' });
      return;
    }
    this.channel = new BroadcastChannel(`tank-room-${this.room}`);
    this.channel.onmessage = (event: MessageEvent<GameCommand>) => {
      this.events.emit('command', event.data);
    };
    this.events.emit('status', { state: 'open', detail: `房间 ${this.room}` });
  }

  send(command: GameCommand): void {
    this.channel?.postMessage(command);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
    this.events.emit('status', { state: 'closed', detail: `房间 ${this.room}` });
  }
}
