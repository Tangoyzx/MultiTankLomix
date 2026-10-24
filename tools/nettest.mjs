/**
 * 远端链路自测：起一个真实的站点服务（静态 + WebSocket 同一端口），
 * 用一个零依赖的 WebSocket 客户端走一遍完整协议：
 * 握手 → 排队 → 配对 → 选坦同步 → 双方就绪开局 → 移动/发射/回合校正中继
 * → 掉线重连；顺带校验缓存头，确保玩家每次打开都拿最新版本。
 *
 * 用法：node tools/build.mjs && node tools/nettest.mjs
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { startServer } from './serve.mjs';
import { connectWebSocket } from './rawWs.mjs';

const DIST = resolve(process.cwd(), 'dist');
const CONFIG_HASH = 'nettest-hash';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 一个带收件箱的测试用客户端。 */
async function connect(base, { configHash = CONFIG_HASH, resumeToken = null } = {}) {
  const [host, port] = base.split(':');
  const socket = await connectWebSocket({ host, port: Number(port), path: '/ws' });
  const inbox = [];
  socket.on('message', (text) => {
    try {
      inbox.push(JSON.parse(text));
    } catch {
      /* 忽略坏帧 */
    }
  });
  const client = {
    socket,
    inbox,
    token: null,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    handshake() {
      socket.send(
        JSON.stringify({
          type: 'handshake',
          playerId: 'left',
          configHash,
          version: 'nettest',
          ...(resumeToken ? { resumeToken } : {}),
        }),
      );
    },
    /** 等到某类命令出现（返回第一条），并把之前收到的消息留在收件箱里。 */
    async waitFor(type, { timeout = 3000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const index = inbox.findIndex((m) => m.type === type);
        if (index >= 0) return inbox[index];
        if (Date.now() > deadline) throw new Error(`等待 ${type} 超时（收到 ${inbox.map((m) => m.type).join(',') || '空'}）`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async waitForMatch(type, predicate, { timeout = 3000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = inbox.find((m) => m.type === type && predicate(m));
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`等待 ${type}（带条件）超时`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    /** 等到其中任意一类命令出现（例如重连握手只会回 resumed）。 */
    async waitForAny(types, { timeout = 3000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = inbox.find((m) => types.includes(m.type));
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`等待 ${types.join('/')} 超时`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    clear() {
      inbox.length = 0;
    },
    close() {
      try {
        socket.close();
      } catch {
        /* 已关 */
      }
    },
  };
  client.handshake();
  // 正常握手回 helloAck；带 resumeToken 重连成功时服务端只回 resumed。
  const welcome = await client.waitForAny(['helloAck', 'resumed']);
  client.token = welcome.resumeToken ?? resumeToken;
  return client;
}

const server = await startServer({ port: 0, host: '127.0.0.1', root: DIST });
const base = `127.0.0.1:${server.port}`;
const httpBase = `http://${base}`;

section('缓存与版本');

await test('入口 / 与 /version.json 都是 no-store', async () => {
  for (const path of ['/', '/index.html', '/version.json']) {
    const response = await fetch(`${httpBase}${path}`);
    assert.equal(response.status, 200, `${path} 应可访问`);
    const cacheControl = response.headers.get('cache-control') ?? '';
    assert.match(cacheControl, /no-store/, `${path} 缺少 no-store：${cacheControl}`);
    assert.match(cacheControl, /must-revalidate/, `${path} 缺少 must-revalidate：${cacheControl}`);
    assert.equal(response.headers.get('pragma'), 'no-cache', `${path} 缺少 Pragma`);
  }
});

await test('/version.json 暴露版本号与构建指纹', async () => {
  const payload = await fetch(`${httpBase}/version.json`).then((r) => r.json());
  assert.equal(typeof payload.version, 'string', '缺少 version');
  assert.ok(payload.build || payload.gitCommit, '缺少 build 指纹或 commit');
});

await test('js/css 带 ETag 且命中 304（no-cache 每次回源校验）', async () => {
  const first = await fetch(`${httpBase}/main.js`);
  assert.equal(first.status, 200);
  const cacheControl = first.headers.get('cache-control') ?? '';
  assert.match(cacheControl, /no-cache/, `main.js 应为 no-cache：${cacheControl}`);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'main.js 缺少 ETag');
  const second = await fetch(`${httpBase}/main.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304, `带 ETag 再取应回 304，实际 ${second.status}`);
});

await test('页面里注入了 app-version，握手会带上它', async () => {
  const html = await fetch(`${httpBase}/`).then((r) => r.text());
  assert.match(html, /<meta name="app-version" content="[^"]+"/, 'index.html 缺少 app-version meta');
});

await test('入口的资源带构建指纹查询串，和 /version.json 对得上', async () => {
  const [html, payload] = await Promise.all([
    fetch(`${httpBase}/`).then((r) => r.text()),
    fetch(`${httpBase}/version.json`).then((r) => r.json()),
  ]);
  const build = payload.build;
  assert.ok(build, '/version.json 没有 build 指纹');
  assert.match(html, /<meta name="app-build" content="[^"]+"/, 'index.html 缺少 app-build meta');
  assert.match(html, new RegExp(`<meta name="app-build" content="${build}"`), 'meta 指纹与 version.json 不一致');
  // 资源文件名不带哈希，靠 ?v=<指纹> 让旧缓存自然失效
  assert.match(html, new RegExp(`main\\.js\\?v=${build}`), `main.js 缺少 ?v=${build}`);
  assert.match(html, new RegExp(`styles\\.css\\?v=${build}`), `styles.css 缺少 ?v=${build}`);
});

await test('带指纹的资源仍能取到，且每次回源校验', async () => {
  const payload = await fetch(`${httpBase}/version.json`).then((r) => r.json());
  const response = await fetch(`${httpBase}/main.js?v=${payload.build}`);
  assert.equal(response.status, 200, '带查询串的资源应能取到');
  assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
});

await test('握手回执带服务端构建指纹，客户端据此判断该不该刷新', async () => {
  const payload = await fetch(`${httpBase}/version.json`).then((r) => r.json());
  const a = await connect(base);
  const ack = a.inbox.find((m) => m.type === 'helloAck');
  assert.ok(ack, '没有收到 helloAck');
  assert.equal(ack.serverVersion, payload.version, '服务端版本与 version.json 不一致');
  assert.equal(ack.serverBuild, payload.build, '服务端构建指纹与 version.json 不一致');
  a.close();
});

section('快速匹配');

await test('第一个人排队收到 queued，第二个人进来双方收到 matched', async () => {
  const a = await connect(base);
  a.send({ type: 'join' });
  const queued = await a.waitFor('queued');
  assert.equal(queued.reason, 'waiting');

  const b = await connect(base);
  b.send({ type: 'join' });

  const aMatched = await a.waitFor('matched');
  const bMatched = await b.waitFor('matched');
  assert.equal(aMatched.roomId, bMatched.roomId, '双方应在同一房间');
  assert.equal(aMatched.seed, bMatched.seed, '双方应拿到同一个种子');
  assert.equal(aMatched.seat, 'left', '先到者坐左席（先手）');
  assert.equal(bMatched.seat, 'right', '后到者坐右席');
  a.close();
  b.close();
});

await test('配置哈希不同不会配到一起', async () => {
  const a = await connect(base, { configHash: 'hash-a' });
  const b = await connect(base, { configHash: 'hash-b' });
  a.send({ type: 'join' });
  b.send({ type: 'join' });
  await a.waitFor('queued');
  await b.waitFor('queued');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(a.inbox.some((m) => m.type === 'matched'), false, '配置不一致不应配对');
  assert.equal(b.inbox.some((m) => m.type === 'matched'), false, '配置不一致不应配对');
  a.close();
  b.close();
});

section('选坦与开局');

/** 起一局已经配对好的对局，返回两个客户端。 */
async function pair(target = base, { seed } = {}) {
  const a = await connect(target);
  a.send({ type: 'join' });
  const b = await connect(target);
  b.send({ type: 'join' });
  const aMatched = await a.waitFor('matched');
  await b.waitFor('matched');
  a.clear();
  b.clear();
  return { a, b, seed: seed ?? aMatched.seed };
}

await test('选择会同步给对手，双方就绪后收到同一份 start', async () => {
  const { a, b, seed } = await pair();

  a.send({ type: 'pick', playerId: 'left', tankId: 'hammer' });
  const bPick = await b.waitFor('pick');
  assert.equal(bPick.playerId, 'left');
  assert.equal(bPick.tankId, 'hammer', '对手应看到左边选了重锤');

  b.send({ type: 'pick', playerId: 'right', tankId: 'scout' });
  const aPick = await a.waitFor('pick');
  assert.equal(aPick.tankId, 'scout');

  a.send({ type: 'ready', playerId: 'left', picks: { left: 'hammer', right: 'scout' } });
  const bReady = await b.waitFor('opponentReady');
  assert.ok(bReady, '对手应收到已就绪通知');
  assert.equal(b.inbox.some((m) => m.type === 'start'), false, '只有一方就绪不应开局');

  b.send({ type: 'ready', playerId: 'right', picks: { left: 'standard', right: 'scout' } });
  const aStart = await a.waitFor('start');
  const bStart = await b.waitFor('start');
  assert.equal(aStart.seed, seed, 'start 的种子应与 matched 一致');
  assert.equal(aStart.seed, bStart.seed);
  assert.deepEqual(aStart.picks, { left: 'hammer', right: 'scout' }, '各自席位的选择应合并');
  assert.deepEqual(bStart.picks, aStart.picks, '两端必须拿到完全相同的坦克搭配');

  a.close();
  b.close();
});

section('对局中继');

await test('移动 / 发射 / 回合校正都原样转给对手', async () => {
  const { a, b } = await pair();
  a.send({ type: 'ready', playerId: 'left', picks: { left: 'standard', right: 'standard' } });
  b.send({ type: 'ready', playerId: 'right', picks: { left: 'standard', right: 'standard' } });
  await a.waitFor('start');
  await b.waitFor('start');
  a.clear();
  b.clear();

  a.send({ type: 'move', playerId: 'left', dir: 1, distance: 42 });
  const move = await b.waitFor('move');
  assert.equal(move.playerId, 'left', '移动命令应带操作方席位');
  assert.equal(move.distance, 42);

  a.send({ type: 'shot', playerId: 'left', angleDeg: 45, power: 0.8, dirSign: 1 });
  const shot = await b.waitFor('shot');
  assert.equal(shot.angleDeg, 45);
  assert.equal(shot.power, 0.8);

  a.send({ type: 'sync', playerId: 'left', hp: 96, x: 123.5, y: 456.25, rotation: 0.12, windLevel: 2 });
  const sync = await b.waitFor('sync');
  assert.equal(sync.hp, 96);
  assert.equal(sync.x, 123.5);
  assert.equal(sync.windLevel, 2, '风向也要一起校正');

  assert.equal(a.inbox.some((m) => m.type === 'move'), false, '不应把命令回声发回自己');

  a.close();
  b.close();
});

section('掉线与重连');

await test('战斗中掉线给宽限期，带 resumeToken 能回到原席位', async () => {
  const { a, b } = await pair();
  a.send({ type: 'ready', playerId: 'left', picks: { left: 'standard', right: 'standard' } });
  b.send({ type: 'ready', playerId: 'right', picks: { left: 'standard', right: 'standard' } });
  await a.waitFor('start');
  await b.waitFor('start');
  b.clear();

  const aToken = a.token;
  a.socket.close();
  const left = await b.waitFor('opponentLeft');
  assert.equal(left.duringBattle, true, '战斗中掉线要标记 duringBattle');
  assert.equal(left.reconnecting, true, '应先给重连宽限');
  assert.ok(left.graceSeconds >= 10, `宽限秒数异常：${left.graceSeconds}`);

  const reconnected = await connect(base, { resumeToken: aToken });
  const resumed = await reconnected.waitFor('resumed');
  assert.equal(resumed.seat, 'left', '重连应回到原来的席位');
  const peerNotice = await b.waitFor('opponentReconnected');
  assert.ok(peerNotice, '对手应收到重连通知');

  // 重连后命令中继要立刻恢复
  b.clear();
  reconnected.send({ type: 'move', playerId: 'left', dir: -1, distance: 12 });
  const afterResume = await b.waitFor('move');
  assert.equal(afterResume.dir, -1);

  reconnected.close();
  b.close();
});

await test('宽限期过后仍未回来，对手收到最终离开通知', async () => {
  // 单独起一台宽限很短的服务，避免这条用例真的等 20 秒。
  const fast = await startServer({ port: 0, host: '127.0.0.1', root: DIST, reconnectGraceMs: 600 });
  const fastBase = `127.0.0.1:${fast.port}`;
  try {
    const { a, b } = await pair(fastBase);
    b.clear();
    a.socket.close();
    const first = await b.waitFor('opponentLeft');
    assert.equal(first.reconnecting, true, '先给宽限');
    const final = await b.waitForMatch('opponentLeft', (m) => m.reconnecting === false, { timeout: 5000 });
    assert.equal(final.duringBattle, false, '选坦阶段掉线不应标记战斗中');
    a.close();
    b.close();
  } finally {
    await fast.close();
  }
});

await server.close();

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
  process.exit(1);
}
