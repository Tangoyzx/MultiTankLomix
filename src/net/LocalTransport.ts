import { Emitter } from '../core/events.js';
import type { GameCommand, Transport, TransportEvents, TransportKind } from './Transport.js';

/**
 * 本地传输：不做网络往返，只把命令留档并广播给订阅者。
 * 本地双人模式下 GameApp 用它做命令日志（不订阅回声，避免重复执行），
 * 自动化测试也可以订阅它校验“移动/发射”是否按预期产生。
 */
export class LocalTransport implements Transport {
  readonly kind: TransportKind = 'local';
  readonly events = new Emitter<TransportEvents>();
  readonly log: GameCommand[] = [];

  connect(): void {
    this.events.emit('status', { state: 'open', detail: '本地' });
  }

  send(command: GameCommand): void {
    this.log.push(command);
    this.events.emit('command', command);
  }

  close(): void {
    this.events.emit('status', { state: 'closed', detail: '本地' });
  }
}
