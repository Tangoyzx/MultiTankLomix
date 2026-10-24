/**
 * 测试用的极简 WebSocket 客户端（只依赖 node:net）。
 *
 * 本机 Node 内置的 undici WebSocket 连不上任何 ws 服务（握手阶段就失败），
 * 所以远端自测自己走一遍握手与帧编解码，顺便验证服务端返回的
 * Sec-WebSocket-Accept 是否正确。
 *
 * 用法：const socket = await connectWebSocket({ host, port, path: '/ws' });
 */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import { acceptKey } from '../server/ws.mjs';

const MAX_FRAME_BYTES = 1024 * 1024;

/** 客户端发出的帧必须带掩码。 */
function maskFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = body.length;
  let headerLength = 2;
  // 2 字节基础头 + 扩展长度（0/2/8）+ 4 字节掩码
  if (length >= 65536) headerLength += 12;
  else if (length > 125) headerLength += 6;
  else headerLength += 4;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (length >= 65536) {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  } else if (length > 125) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | length;
  }
  const mask = randomBytes(4);
  const maskOffset = headerLength - 4;
  mask.copy(header, maskOffset);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, masked]);
}

function readServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('帧过长');
    length = Number(big);
    offset += 8;
  }
  const total = offset + length;
  if (buffer.length < total) return null;
  return { fin, opcode, payload: Buffer.from(buffer.subarray(offset, total)), total };
}

/**
 * 建立一个 WebSocket 连接。返回对象带 send / close / 事件回调，
 * 事件用 on('message' | 'close') 注册。
 */
export function connectWebSocket({ host = '127.0.0.1', port, path = '/ws' } = {}) {
  const key = randomBytes(16).toString('base64');
  const handlers = { message: [], close: [] };
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;
  let open = false;
  let settled = false;

  const socket = connect({ host, port });
  socket.setNoDelay(true);

  const connection = {
    on(event, handler) {
      handlers[event].push(handler);
      return connection;
    },
    send(text) {
      socket.write(maskFrame(0x1, text));
    },
    close(code = 1000) {
      if (!open) {
        socket.destroy();
        return;
      }
      open = false;
      try {
        socket.write(maskFrame(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])));
      } catch {
        /* 已经关了就算了 */
      }
      socket.end();
    },
    destroy() {
      open = false;
      socket.destroy();
    },
  };

  const emit = (event, ...args) => {
    for (const handler of [...handlers[event]]) handler(...args);
  };

  const complete = (value) => {
    if (settled) return;
    settled = true;
    open = true;
    pending.resolve(value);
  };
  const fail = (error) => {
    if (settled) {
      emit('close', error);
      return;
    }
    settled = true;
    open = false;
    socket.destroy();
    pending.reject(error);
  };

  let pending = null;
  const ready = new Promise((resolve, reject) => {
    pending = { resolve, reject };
  });
  connection.ready = ready;

  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
  });

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (!handshakeDone) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 4);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const headers = new Map(
        headerLines.map((line) => {
          const index = line.indexOf(':');
          return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
        }),
      );
      if (status !== 101) {
        fail(new Error(`握手失败，服务端返回 ${statusLine}`));
        return;
      }
      if (headers.get('sec-websocket-accept') !== acceptKey(key)) {
        fail(new Error('Sec-WebSocket-Accept 校验不通过'));
        return;
      }
      handshakeDone = true;
      complete(connection);
    }

    try {
      for (;;) {
        const parsed = readServerFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.total);
        if (parsed.opcode === 0x8) {
          connection.destroy();
          emit('close');
          return;
        }
        if (parsed.opcode === 0x9) {
          socket.write(maskFrame(0xa, parsed.payload));
          continue;
        }
        if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
          emit('message', parsed.payload.toString('utf8'));
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });

  socket.on('error', (error) => {
    if (settled) emit('close', error);
    else fail(error);
  });

  socket.on('close', () => {
    open = false;
    emit('close');
  });

  return ready;
}
