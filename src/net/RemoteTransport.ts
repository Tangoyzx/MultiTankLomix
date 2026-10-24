import { Emitter } from '../core/events.js';
import { gameplayConfigHash } from '../config.js';
import type { PlayerId } from '../core/types.js';
import type { GameCommand, Transport, TransportEvents, TransportKind } from './Transport.js';

const WS_PATH = '/ws';
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];

function readAppVersion(): string {
  const meta = document.querySelector('meta[name="app-version"]');
  return meta?.getAttribute('content') ?? 'dev';
}

/**
 * 远端传输：一条 WebSocket 连到匹配服务器（网页与 ws 同源，部署后无需额外配置）。
 * 连上先握手（带玩法配置哈希与重连凭据），由服务端快速匹配；
 * 之后自己的操作照常本地执行并发出去，收到的命令交给上层回放。
 * 意外断线会在 5 次内退避重连，并带 resumeToken 回原房间。
 */
export class RemoteTransport implements Transport {
  readonly kind: TransportKind = 'remote';
  readonly events = new Emitter<TransportEvents>();

  private readonly endpoint: string;
  private socket: WebSocket | null = null;
  private queue: GameCommand[] = [];
  private active = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private resumeToken: string | null = null;
  private seat: PlayerId = 'left';
  /** 连上后自动请求加入快速匹配队列（调试用的同浏览器联调不需要）。 */
  private readonly autoJoin: boolean;

  constructor(endpoint?: string, { autoJoin = true } = {}) {
    this.endpoint = endpoint ?? defaultEndpoint();
    this.autoJoin = autoJoin;
  }

  get url(): string {
    return this.endpoint;
  }

  connect(): void {
    this.active = true;
    this.open();
  }

  send(command: GameCommand): void {
    if (command.type === 'handshake') this.seat = command.playerId;
    this.queue.push(command);
    this.flush();
  }

  close(): void {
    this.active = false;
    this.clearReconnect();
    if (this.socket && this.ready) {
      try {
        this.socket.send(JSON.stringify({ type: 'leave' }));
      } catch {
        /* 关不掉就算了 */
      }
    }
    this.detach();
    this.socket?.close();
    this.socket = null;
    this.queue = [];
    this.events.emit('status', { state: 'closed', detail: '已断开' });
  }

  private get ready(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private open(): void {
    this.events.emit('status', { state: 'connecting', detail: '正在连接服务器…' });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.endpoint);
    } catch (error) {
      this.events.emit('status', { state: 'error', detail: errorMessage(error) });
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      socket.send(
        JSON.stringify({
          type: 'handshake',
          playerId: this.seat,
          configHash: gameplayConfigHash(),
          version: readAppVersion(),
          ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
        }),
      );
      // 握手排在 join 前面：服务端要先记下 configHash 才配得上对。
      if (this.autoJoin) this.queue.unshift({ type: 'join' });
      this.flush();
      this.events.emit('status', { state: 'open', detail: '已连接' });
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.onMessage(event.data);
    };

    socket.onerror = () => {
      this.events.emit('status', { state: 'error', detail: '连接异常，正在重试…' });
    };

    socket.onclose = () => {
      this.detach();
      if (this.socket === socket) this.socket = null;
      if (!this.active) return;
      this.scheduleReconnect();
    };
  }

  private detach(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.attempt >= RECONNECT_DELAYS.length) {
      this.active = false;
      this.events.emit('status', { state: 'error', detail: '连接已断开，请返回主界面重试' });
      return;
    }
    const delay = RECONNECT_DELAYS[this.attempt++];
    this.events.emit('status', { state: 'connecting', detail: `连接中断，${Math.round(delay / 1000)} 秒后重试…` });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flush(): void {
    if (!this.ready) return;
    const socket = this.socket;
    if (!socket) return;
    while (this.queue.length > 0) {
      const command = this.queue.shift();
      if (!command) break;
      try {
        socket.send(JSON.stringify(command));
      } catch {
        this.queue.unshift(command);
        return;
      }
    }
  }

  private onMessage(raw: string): void {
    let command: GameCommand;
    try {
      command = JSON.parse(raw) as GameCommand;
    } catch {
      return;
    }
    if (!command || typeof command.type !== 'string') return;
    if (command.type === 'helloAck') {
      if (typeof command.resumeToken === 'string') this.resumeToken = command.resumeToken;
      // 也交给上层：版本不一致时提示玩家刷新拿最新资源。
      this.events.emit('command', command);
      return;
    }
    if (command.type === 'matched' || command.type === 'resumed') this.seat = command.seat;
    this.events.emit('command', command);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '远端连接失败';
}

/** 默认同源；本地联调可以用 ?server=ws://host:port/ws 覆盖。 */
export function defaultEndpoint(): string {
  const override = new URLSearchParams(window.location.search).get('server');
  if (override) return override;
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${WS_PATH}`;
}
