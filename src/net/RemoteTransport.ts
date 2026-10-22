import { Emitter } from '../core/events.js';
import type { GameCommand, Transport, TransportEvents, TransportKind } from './Transport.js';
import { NotImplementedError } from './Transport.js';

/**
 * 远端游玩的占位实现：接口、握手校验、收发签名都已经定好，
 * 真正接入服务器（WebSocket / WebRTC）时只需替换 connect/send 的内部实现，
 * 上层 GameApp 与 TurnController 无需改动。
 */
export class RemoteTransport implements Transport {
  readonly kind: TransportKind = 'remote';
  readonly events = new Emitter<TransportEvents>();
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  connect(): void {
    this.events.emit('status', { state: 'error', detail: '远端尚未接入' });
    throw new NotImplementedError(`远端多人游玩暂未开放（${this.endpoint}）`);
  }

  send(_command: GameCommand): void {
    throw new NotImplementedError('远端多人游玩暂未开放');
  }

  close(): void {
    this.events.emit('status', { state: 'closed', detail: '远端未连接' });
  }
}
