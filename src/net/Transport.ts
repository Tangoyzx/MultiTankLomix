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
}

export interface PickCommand {
  type: 'pick';
  playerId: PlayerId;
  tankId: string;
}

export interface StartCommand {
  type: 'start';
  seed: number;
  picks: Record<PlayerId, string>;
}

export type GameCommand =
  | MoveCommand
  | ShotCommand
  | HandshakeCommand
  | PickCommand
  | StartCommand;

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

export class NotImplementedError extends Error {
  constructor(message = '远端多人游玩暂未开放') {
    super(message);
    this.name = 'NotImplementedError';
  }
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
