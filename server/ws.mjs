import { createHash, randomUUID } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11C';
const MAX_CONTROL_PAYLOAD = 125;
const MAX_FRAME_BYTES = 1024 * 1024;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** 把一个或多个 WebSocket 帧编码成未掩码的报文（服务端发出的帧不带掩码）。 */
export function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = body.length;
  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length > 125) headerLength += 2;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (length >= 65536) {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  } else if (length > 125) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = length;
  }
  return Buffer.concat([header, body]);
}

/** 只处理 opcode 1/2/8/9/10；分片会累积到 FIN 帧再交给上层。 */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
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
  if (length > MAX_FRAME_BYTES) throw new Error('帧过长');
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  const total = offset + length;
  if (buffer.length < total) return null;
  const payload = Buffer.from(buffer.subarray(offset, total));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { fin, opcode, payload, total };
}

export class WsConnection {
  constructor(socket, id) {
    this.id = id;
    this.socket = socket;
    this.alive = true;
    this.handlers = { message: [], close: [] };
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = 0;
    this.fragmentChunks = [];

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onSocketClose());
    socket.on('error', () => this.onSocketClose());
    this.startHeartbeat();
  }

  on(event, handler) {
    this.handlers[event].push(handler);
    return this;
  }

  startHeartbeat() {
    this.pingTimer = setInterval(() => {
      if (!this.alive) return;
      this.sendRaw(frame(0x9, Buffer.alloc(0)));
      this.pongTimer = setTimeout(() => {
        if (this.alive) this.socket.destroy();
      }, 10000);
    }, 30000);
    this.pingTimer.unref?.();
  }

  onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const parsed = readFrame(this.buffer);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.total);
        this.handleFrame(parsed);
        if (!this.alive) return;
      }
    } catch {
      this.destroy();
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (opcode === 0x9) {
      this.sendRaw(frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        if (this.fragmentOpcode === 0) this.fragmentOpcode = opcode;
        this.fragmentChunks.push(payload);
        return;
      }
      const chunks = this.fragmentChunks;
      const messageOpcode = this.fragmentOpcode || opcode;
      this.fragmentOpcode = 0;
      this.fragmentChunks = [];
      const body = chunks.length ? Buffer.concat([...chunks, payload]) : payload;
      for (const handler of this.handlers.message) handler(body.toString('utf8'), this);
    }
  }

  sendRaw(buffer) {
    if (!this.alive) return;
    try {
      this.socket.write(buffer);
    } catch {
      this.destroy();
    }
  }

  sendText(text) {
    this.sendRaw(frame(0x1, text));
  }

  close(code = 1000) {
    if (!this.alive) return;
    this.sendRaw(frame(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])));
    this.destroy();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    try {
      this.socket.destroy();
    } catch {
      /* 已经关了就算了 */
    }
    for (const handler of this.handlers.close) handler(this);
  }

  onSocketClose() {
    this.destroy();
  }
}

/** 完成握手并升级成 WsConnection；调用方负责校验 path 与头。 */
export function upgradeToWebSocket(req, socket) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  return new WsConnection(socket, randomUUID());
}

export function isWebSocketUpgrade(req) {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  return (
    upgrade === 'websocket' &&
    connection.includes('upgrade') &&
    req.headers['sec-websocket-key'] &&
    String(req.headers['sec-websocket-version'] ?? '13') === '13'
  );
}

export function createWsServer({ path = '/ws' } = {}) {
  const handlers = { connection: [] };
  const server = {
    path,
    onConnection(handler) {
      handlers.connection.push(handler);
    },
    handleUpgrade(req, socket) {
      if (!isWebSocketUpgrade(req)) {
        socket.destroy();
        return;
      }
      const connection = upgradeToWebSocket(req, socket);
      for (const handler of handlers.connection) handler(connection, req);
    },
    attach(httpServer) {
      httpServer.on('upgrade', (req, socket) => {
        if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
          socket.destroy();
          return;
        }
        server.handleUpgrade(req, socket);
      });
    },
  };
  return server;
}
