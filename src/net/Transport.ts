import { Emitter } from '../core/events.js';
import type { PlayerId } from '../core/types.js';

export type TransportKind = 'local' | 'remote' | 'broadcast';

export interface MoveCommand {
  type: 'move';
  playerId: PlayerId;
  dir: -1 | 1;
  distance: number;
}

export interface ShotCommand {
  type: 'shot';
  playerId: PlayerId;
  angleDeg: number;
  power: number;
  dirSign: 1 | -1;
}

export interface HandshakeCommand {
  type: 'handshake';
  playerId: PlayerId;
  configHash: string;
  /** 构建版本号，服务端只记录与提示，不作为匹配条件。 */
  version?: string;
  /** 重连凭据：断线后带着它回原房间。 */
  resumeToken?: string;
}

export interface PickCommand {
  type: 'pick';
  playerId: PlayerId;
  tankId: string;
}

/** 请求进入快速匹配队列；服务端凑够两人就下发 matched。 */
export interface JoinCommand {
  type: 'join';
}

export interface StartCommand {
  type: 'start';
  seed: number;
  picks: Record<PlayerId, string>;
}

/** 匹配成功：服务端分配的席位与对局种子。 */
export interface MatchedCommand {
  type: 'matched';
  roomId: string;
  seat: PlayerId;
  seed: number;
}

/** 断线重连回到原房间。 */
export interface ResumedCommand {
  type: 'resumed';
  roomId: string;
  seat: PlayerId;
  seed: number;
  phase: string;
  picks: Record<PlayerId, string>;
}

/** 每回合结束的状态摘要，用来校正两端漂移。 */
export interface SyncCommand {
  type: 'sync';
  playerId: PlayerId;
  hp: number;
  x: number;
  y: number;
  rotation: number;
  windLevel: number;
}

export interface OpponentLeftCommand {
  type: 'opponentLeft';
  duringBattle: boolean;
  reconnecting: boolean;
  graceSeconds: number;
}

export interface ErrorCommand {
  type: 'error';
  code: string;
  message: string;
}

export interface QueuedCommand {
  type: 'queued';
  reason: string;
}

/** 服务端确认握手并下发重连凭据。 */
export interface HelloAckCommand {
  type: 'helloAck';
  serverVersion: string;
  /** 服务端当前部署的构建指纹，客户端拿它判断是不是该刷新了。 */
  serverBuild?: string;
  resumeToken: string;
}

/** 对手已确认出战。 */
export interface OpponentReadyCommand {
  type: 'opponentReady';
}

/** 对手重连成功。 */
export interface OpponentReconnectedCommand {
  type: 'opponentReconnected';
}

export interface LeaveCommand {
  type: 'leave';
}

export interface ReadyCommand {
  type: 'ready';
  playerId: PlayerId;
  picks: Record<PlayerId, string>;
}

export type GameCommand =
  | MoveCommand
  | ShotCommand
  | HandshakeCommand
  | PickCommand
  | StartCommand
  | ReadyCommand
  | MatchedCommand
  | JoinCommand
  | ResumedCommand
  | SyncCommand
  | OpponentLeftCommand
  | ErrorCommand
  | QueuedCommand
  | HelloAckCommand
  | OpponentReadyCommand
  | OpponentReconnectedCommand
  | LeaveCommand;

export type TransportState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface TransportStatus {
  state: TransportState;
  detail: string;
}

export type TransportEvents = {
  command: GameCommand;
  status: TransportStatus;
};

/**
 * 远端游玩的唯一契约。
 * 本地双人：命令直接作用于本地回合（可用 LocalTransport 记录）。
 * 远端：本方回合照常本地操作并把命令发出去；对方回合 inputLocked，
 * 只把收到的命令交给 TurnController.applyRemoteMove / applyRemoteShot 回放。
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly events: Emitter<TransportEvents>;
  connect(): void;
  send(command: GameCommand): void;
  close(): void;
}

export class ConfigMismatchError extends Error {
  readonly localHash: string;
  readonly remoteHash: string;

  constructor(localHash: string, remoteHash: string) {
    super(`双方配置不一致（本地 ${localHash} / 远端 ${remoteHash}），无法开始对局`);
    this.name = 'ConfigMismatchError';
    this.localHash = localHash;
    this.remoteHash = remoteHash;
  }
}

export function assertConfigMatch(localHash: string, remoteHash: string): void {
  if (localHash !== remoteHash) throw new ConfigMismatchError(localHash, remoteHash);
}
