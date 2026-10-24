import { randomUUID } from 'node:crypto';
import { createWsServer } from './ws.mjs';

const DEFAULT_RECONNECT_GRACE_MS = 20000;
const QUEUE_STALE_MS = 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * 快速匹配 + 命令中继。
 * 服务端不跑玩法模拟，只做三件事：凑人配对、确认双方配置一致、把命令转给对手。
 * 对局的确定性由双方的 seed + 相同的玩法配置保证，回合结束的 sync 用来兜住漂移。
 */
export function createMatchServer({
  path = '/ws',
  serverVersion = '0.0.0',
  serverBuild = '',
  reconnectGraceMs = DEFAULT_RECONNECT_GRACE_MS,
} = {}) {
  const ws = createWsServer({ path });
  const RECONNECT_GRACE_MS = Number(reconnectGraceMs) || DEFAULT_RECONNECT_GRACE_MS;
  /** @type {Array<{send:Function, configHash:string, version:string, resumeToken:string, seat:'left'|'right', roomId:string|null, enqueuedAt:number}>} */
  const clients = [];
  const rooms = new Map();
  const timers = new Map();
  let counter = 0;

  function send(client, message) {
    if (!client) return;
    try {
      client.send(JSON.stringify(message));
    } catch {
      /* 连接已断，忽略 */
    }
  }

  function roomOf(client) {
    return client?.roomId ? rooms.get(client.roomId) ?? null : null;
  }

  function setTimer(key, fn, ms) {
    clearTimer(key);
    const timer = setTimeout(() => {
      timers.delete(key);
      fn();
    }, ms);
    timer.unref?.();
    timers.set(key, timer);
  }

  function clearTimer(key) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  function clearRoomTimers(roomId) {
    clearTimer(`${roomId}:left`);
    clearTimer(`${roomId}:right`);
  }

  function dropRoom(roomId) {
    clearRoomTimers(roomId);
    rooms.delete(roomId);
  }

  function removeFromQueue(client) {
    const index = clients.indexOf(client);
    if (index >= 0) clients.splice(index, 1);
  }

  function tryMatch(client) {
    const now = Date.now();
    for (let i = clients.length - 1; i >= 0; i--) {
      if (now - clients[i].enqueuedAt > QUEUE_STALE_MS) clients.splice(i, 1);
    }
    if (!clients.includes(client)) return;
    const partner = clients.find((other) => other !== client && other.configHash === client.configHash);
    if (!partner) {
      send(client, { type: 'queued', reason: 'waiting' });
      return;
    }
    removeFromQueue(partner);
    removeFromQueue(client);
    if (partner.configHash !== client.configHash) {
      send(client, { type: 'error', code: 'configMismatch', message: '双方游戏配置不一致，无法开局' });
      send(partner, { type: 'error', code: 'configMismatch', message: '双方游戏配置不一致，无法开局' });
      return;
    }
    const roomId = `r${(++counter).toString(36)}-${randomUUID().slice(0, 6)}`;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const room = {
      id: roomId,
      phase: 'select',
      seed,
      configHash: client.configHash,
      players: [
        { seat: 'left', client: partner, resumeToken: partner.resumeToken, picks: 'standard', ready: false, leave: null },
        { seat: 'right', client, resumeToken: client.resumeToken, picks: 'standard', ready: false, leave: null },
      ],
    };
    rooms.set(roomId, room);
    for (const player of room.players) {
      player.client.roomId = roomId;
      player.client.seat = player.seat;
      send(player.client, { type: 'matched', roomId, seat: player.seat, seed });
    }
  }

  function startBattleIfReady(room) {
    if (!room || room.phase !== 'select') return;
    if (!room.players.every((player) => player.ready && player.client?.alive)) return;
    room.phase = 'battle';
    const picks = { left: room.players[0].picks, right: room.players[1].picks };
    for (const player of room.players) {
      send(player.client, { type: 'start', seed: room.seed, picks });
    }
  }

  function finishLeave(roomId, seat) {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((item) => item.seat === seat);
    if (!player || player.leave !== 'disconnected') return;
    player.leave = 'left';
    player.client = null;
    const opponent = room.players.find((item) => item.seat !== seat);
    if (opponent?.client?.alive) {
      send(opponent.client, {
        type: 'opponentLeft',
        duringBattle: room.phase === 'battle',
        reconnecting: false,
        graceSeconds: 0,
      });
    }
    const allGone = room.players.every((item) => item.leave === 'left' || !item.client?.alive);
    if (allGone) dropRoom(roomId);
  }

  function handleLeave(client, { graceful }) {
    const wasInQueue = clients.includes(client);
    if (wasInQueue) removeFromQueue(client);
    const room = roomOf(client);
    client.roomId = null;
    if (!room) return;
    clearRoomTimers(room.id);
    const player = room.players.find((item) => item.client === client);
    if (!player) return;
    const opponent = room.players.find((item) => item.seat !== player.seat);

    // 意外断线一律给一段重连宽限：选坦时手滑刷新不该把对手踢回主界面。
    if (!graceful && opponent?.client?.alive) {
      player.leave = 'disconnected';
      send(opponent.client, {
        type: 'opponentLeft',
        duringBattle: true,
        reconnecting: true,
        graceSeconds: Math.round(RECONNECT_GRACE_MS / 1000),
      });
      setTimer(`${room.id}:${player.seat}`, () => finishLeave(room.id, player.seat), RECONNECT_GRACE_MS);
      return;
    }

    player.leave = 'left';
    player.client = null;
    if (opponent?.client?.alive) {
      send(opponent.client, {
        type: 'opponentLeft',
        duringBattle: room.phase === 'battle',
        reconnecting: false,
        graceSeconds: 0,
      });
    }
    const allGone = room.players.every((item) => item.leave === 'left' || !item.client?.alive);
    if (allGone) dropRoom(room.id);
  }

  function handleResume(client) {
    for (const room of rooms.values()) {
      const player = room.players.find((item) => item.leave === 'disconnected' && item.resumeToken === client.resumeToken);
      if (!player) continue;
      clearTimer(`${room.id}:${player.seat}`);
      player.leave = null;
      player.client = client;
      player.resumeToken = client.resumeToken;
      client.roomId = room.id;
      client.seat = player.seat;
      send(client, {
        type: 'resumed',
        roomId: room.id,
        seat: player.seat,
        seed: room.seed,
        phase: room.phase,
        picks: { left: room.players[0].picks, right: room.players[1].picks },
      });
      const opponent = room.players.find((item) => item.seat !== player.seat);
      if (opponent?.client?.alive) send(opponent.client, { type: 'opponentReconnected' });
      return true;
    }
    return false;
  }

  function onCommand(client, raw) {
    if (raw.length > MAX_MESSAGE_BYTES) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    const room = roomOf(client);

    switch (message.type) {
      case 'join': {
        if (room || clients.includes(client)) return;
        client.enqueuedAt = Date.now();
        clients.push(client);
        tryMatch(client);
        return;
      }
      case 'pick': {
        if (!room || room.phase !== 'select') return;
        const player = room.players.find((item) => item.client === client);
        if (!player || typeof message.tankId !== 'string') return;
        player.picks = message.tankId;
        const opponent = room.players.find((item) => item.seat !== player.seat);
        send(opponent?.client, { type: 'pick', playerId: player.seat, tankId: player.picks });
        return;
      }
      case 'ready': {
        if (!room || room.phase !== 'select') return;
        const player = room.players.find((item) => item.client === client);
        if (!player) return;
        if (message.picks && typeof message.picks[player.seat] === 'string') {
          player.picks = message.picks[player.seat];
        }
        player.ready = true;
        const opponent = room.players.find((item) => item.seat !== player.seat);
        send(opponent?.client, { type: 'opponentReady' });
        startBattleIfReady(room);
        return;
      }
      case 'move':
      case 'shot':
      case 'sync': {
        if (!room) return;
        const player = room.players.find((item) => item.client === client);
        const opponent = room.players.find((item) => item.seat !== player?.seat);
        send(opponent?.client, { ...message, playerId: player?.seat ?? message.playerId });
        return;
      }
      case 'leave': {
        handleLeave(client, { graceful: true });
        return;
      }
      default:
        return;
    }
  }

  ws.onConnection((connection) => {
    const client = {
      id: connection.id,
      send: (text) => connection.sendText(text),
      configHash: '',
      version: '',
      resumeToken: randomUUID(),
      seat: null,
      roomId: null,
      enqueuedAt: Date.now(),
      alive: true,
    };

    connection.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message?.type === 'handshake') {
        client.configHash = String(message.configHash ?? '');
        client.version = String(message.version ?? '');
        if (message.resumeToken) {
          client.resumeToken = String(message.resumeToken);
          if (handleResume(client)) return;
        }
        send(client, { type: 'helloAck', serverVersion, serverBuild, resumeToken: client.resumeToken });
        return;
      }
      onCommand(client, raw);
    });

    connection.on('close', () => {
      client.alive = false;
      handleLeave(client, { graceful: false });
      const index = clients.indexOf(client);
      if (index >= 0) clients.splice(index, 1);
    });
  });

  return {
    ws,
    get stats() {
      return { waiting: clients.length, rooms: rooms.size };
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
