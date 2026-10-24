/**
 * 无浏览器的界面自测：用一个最小 DOM/Canvas 桩把 dist/ 里的界面层跑起来。
 * 覆盖：主界面 → 选坦 → 战斗 HUD → 拖拽开火 → 结算弹窗 → 回主界面，
 * 以及远端模式下“本地回合正常操作 / 对方回合锁输入并回放”的接口契约。
 * 用法：node tools/build.mjs && node tools/domtest.mjs
 */
import assert from 'node:assert/strict';

import { solveShot } from './aimbot.mjs';

// ------------------------------------------------------------------ DOM 桩
const VIEW = { width: 390, height: 844 };
// 固定种子与风力，让地形、风向在每次自测中一致（?seed= 由 GameApp 读取）。
const DETERMINISTIC_URL = '?seed=20251022&wind=3';
let nowMs = 0;
const rafQueue = new Map();
let rafId = 0;

function makeClassList(node) {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    replace: (a, b) => {
      if (set.delete(a)) set.add(b);
    },
    get size() {
      return set.size;
    },
    _set: set,
  };
}

// 真实 CanvasRenderingContext2D 的成员白名单：桩只认这些名字，
// 渲染代码一旦用到浏览器里不存在（或拼错）的 API，这里就会抛错而不是静默通过。
const CTX_METHODS = new Set([
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect',
  'roundRect', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect',
  'clearRect', 'fillText', 'strokeText', 'measureText', 'setLineDash', 'getLineDash', 'translate',
  'scale', 'rotate', 'transform', 'setTransform', 'resetTransform', 'getTransform', 'drawImage',
  'createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern',
  'getImageData', 'putImageData', 'createImageData', 'isPointInPath',
]);
const CTX_PROPS = new Set([
  'canvas', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
  'lineDashOffset', 'globalAlpha', 'globalCompositeOperation', 'shadowBlur', 'shadowColor',
  'shadowOffsetX', 'shadowOffsetY', 'font', 'textAlign', 'textBaseline', 'direction', 'filter',
  'imageSmoothingEnabled', 'imageSmoothingQuality', 'letterSpacing', 'wordSpacing', 'fontKerning',
]);

function makeCtx(canvas) {
  const store = { canvas, calls: new Map() };
  const noop = () => {};
  const record = (name, value) => {
    store.calls.set(name, (store.calls.get(name) ?? 0) + 1);
    return value;
  };
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (prop === 'canvas') return target.canvas;
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (!CTX_METHODS.has(prop) && !CTX_PROPS.has(prop)) {
        throw new Error(`Canvas 上下文不存在成员：${prop}（真实浏览器会报错）`);
      }
      if (CTX_PROPS.has(prop)) return undefined;
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 6 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createConicGradient') {
        return () => ({ addColorStop: noop });
      }
      if (prop === 'createPattern') return () => ({ setTransform: noop });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'getLineDash') return () => [];
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return (...args) => record(prop, args.length);
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && !CTX_PROPS.has(prop) && !(prop in target)) {
        throw new Error(`Canvas 上下文不存在可写属性：${prop}（真实浏览器会静默失效）`);
      }
      target[prop] = value;
      return true;
    },
  });
}

// 选择器词法：标签名 / .class / #id / [attr="value"]，标签名要求至少 1 个字符，
// 避免零宽匹配让每个节点都被判定为命中。
const SELECTOR_TOKEN = /\.[\w-]+|#[\w-]+|\[[^\]]+\]|^[A-Za-z][\w-]*/g;

function matchesCompound(node, compound) {
  const parts = compound.match(SELECTOR_TOKEN) ?? [];
  return parts.every((part) => {
    if (part.startsWith('.')) return node.classList.contains(part.slice(1));
    if (part.startsWith('#')) return node.id === part.slice(1);
    if (part.startsWith('[')) {
      const m = part.slice(1, -1).match(/^data-([a-z-]+)="?([^"\]]*)"?$/);
      if (!m) return false;
      const key = m[1].replace(/-([a-z])/g, (_s, c) => c.toUpperCase());
      return String(node.dataset[key] ?? '') === m[2];
    }
    return part === '' || node.tagName.toLowerCase() === part.toLowerCase();
  });
}

function matchesSelector(node, selector) {
  const chain = selector.trim().split(/\s+/);
  let cursor = node;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!cursor || !matchesCompound(cursor, chain[i])) return false;
    cursor = cursor.parent;
  }
  return true;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = { setProperty: () => {} };
    this.id = '';
    this.disabled = false;
    this.type = '';
    this.width = 0;
    this.height = 0;
    this.clientWidth = 96;
    this.clientHeight = 64;
    this._text = '';
    this._listeners = new Map();
    this.attributes = new Map();
    this.classList = makeClassList(this);
  }

  get className() {
    return [...this.classList._set].join(' ');
  }

  set className(value) {
    this.classList._set.clear();
    for (const name of String(value).split(/\s+/)) if (name) this.classList._set.add(name);
  }

  get textContent() {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this._text = String(value);
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    const value = this.attributes.get(String(name));
    return value === undefined ? null : value;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, extra = {}) {
    const event = { type, preventDefault: () => {}, stopPropagation: () => {}, ...extra };
    for (const fn of [...(this._listeners.get(type) ?? [])]) fn(event);
    return event;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: VIEW.width, bottom: VIEW.height, width: VIEW.width, height: VIEW.height };
  }

  getContext() {
    this._ctx ??= makeCtx(this);
    return this._ctx;
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function walkAll(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walkAll(child, out);
  }
  return out;
}

function findByClass(root, className) {
  return walkAll(root).filter((n) => n.classList.contains(className));
}

const documentShim = {
  listeners: new Map(),
  createElement: (tag) => new El(tag),
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  },
  removeEventListener() {},
  getElementById(id) {
    return documentShim._byId.get(id) ?? null;
  },
  /** 只支持 `meta[name="app-version"]` 这类简单选择器，够界面读版本号用。 */
  querySelector(selector) {
    return documentShim._bySelector.get(selector) ?? null;
  },
  querySelectorAll(selector) {
    const found = documentShim._bySelector.get(selector);
    return found ? [found] : [];
  },
  _byId: new Map(),
  _bySelector: new Map(),
};

/** 同浏览器联调用的最小 BroadcastChannel：同名的频道之间异步转发消息。 */
class BroadcastChannelShim {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const peers = BroadcastChannelShim.channels.get(name) ?? [];
    peers.push(this);
    BroadcastChannelShim.channels.set(name, peers);
  }

  postMessage(data) {
    if (this.closed) return;
    const peers = BroadcastChannelShim.channels.get(this.name) ?? [];
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      setTimeout(() => {
        if (!peer.closed) peer.onmessage?.({ data });
      }, 0);
    }
  }

  close() {
    this.closed = true;
    const peers = BroadcastChannelShim.channels.get(this.name) ?? [];
    const index = peers.indexOf(this);
    if (index >= 0) peers.splice(index, 1);
  }
}
globalThis.BroadcastChannel = BroadcastChannelShim;

/**
 * 远端传输用的 WebSocket 桩：只记录发出去的报文，永不真的联网。
 * 这样界面层能验证“点了远端对战就发 handshake + join 去排队”。
 */
class WebSocketShim {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = WebSocketShim.CONNECTING;
    this.sent = [];
    WebSocketShim.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== WebSocketShim.CONNECTING) return;
      this.readyState = WebSocketShim.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === WebSocketShim.CLOSED) return;
    this.readyState = WebSocketShim.CLOSED;
    this.onclose?.();
  }

  messages() {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}
WebSocketShim.instances = [];
globalThis.WebSocket = WebSocketShim;

const windowShim = {
  listeners: new Map(),
  innerWidth: VIEW.width,
  innerHeight: VIEW.height,
  devicePixelRatio: 2,
  location: {
    search: '',
    reload() {
      windowShim.reloaded = (windowShim.reloaded ?? 0) + 1;
    },
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  },
  dispatch(type, extra = {}) {
    const event = { type, preventDefault: () => {}, stopPropagation: () => {}, ...extra };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return event;
  },
};

globalThis.window = windowShim;
globalThis.document = documentShim;
globalThis.requestAnimationFrame = (cb) => {
  rafId += 1;
  rafQueue.set(rafId, cb);
  return rafId;
};
globalThis.cancelAnimationFrame = (id) => rafQueue.delete(id);

function pump(steps = 1, stepMs = 1000 / 60) {
  for (let i = 0; i < steps; i++) {
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    nowMs += stepMs;
    for (const [, cb] of entries) cb(nowMs);
  }
}

/** 让 BroadcastChannel / setTimeout 的消息与回调落地。 */
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStage() {
  const canvas = new El('canvas');
  const uiRoot = new El('div');
  return { canvas, uiRoot };
}

const { GameApp } = await import('../dist/game/GameApp.js');

function bootApp(search) {
  windowShim.location.search = search;
  const { canvas, uiRoot } = makeStage();
  const app = new GameApp(canvas, uiRoot);
  app.start();
  return { app, canvas, uiRoot };
}

function click(node) {
  assert.ok(node, '待点击的节点不存在');
  node.dispatch('click');
}

function menuButton(uiRoot, label) {
  return walkAll(uiRoot).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
}

// ------------------------------------------------------------------ 用例
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

const { CONFIG, aimDragRadiusPx } = await import('../dist/config.js');

section('主界面');
let local = null;
/** 最近一次按下坦克时的屏幕坐标，用于验证镜头拉远后拖拽原点会跟着坦克走。 */
let lastPressScreen = null;

await test('本地双人与远端对战两个入口都可点', () => {
  local = bootApp(DETERMINISTIC_URL);
  const { app, uiRoot } = local;
  assert.equal(app.screen, 'menu');
  const menu = findByClass(uiRoot, 'menu')[0];
  assert.ok(menu && !menu.classList.contains('hidden'), '主界面应可见');

  const localBtn = menuButton(uiRoot, '本地双人游玩');
  const remoteBtn = menuButton(uiRoot, '远端对战（快速匹配）');
  assert.ok(localBtn, '找不到本地双人按钮');
  assert.ok(remoteBtn, '找不到远端对战按钮');
  assert.notEqual(localBtn.disabled, true, '本地双人按钮应可点');
  assert.notEqual(remoteBtn.disabled, true, '远端对战按钮应可点（远端已开放）');
  assert.ok(remoteBtn.classList.contains('remote-button'), '远端按钮应有独立样式');
  assert.equal(app.state, null, '主界面不应存在对局');
  pump(3);
});

await test('点远端对战进入排队界面，连上就发 handshake + join', async () => {
  const { app, uiRoot } = local;
  click(menuButton(uiRoot, '远端对战（快速匹配）'));
  assert.equal(app.screen, 'matching', '应进入快速匹配等待界面');
  assert.equal(app.mode, 'remote');
  const matchScreen = findByClass(uiRoot, 'match-screen')[0];
  assert.ok(matchScreen && !matchScreen.classList.contains('hidden'), '匹配界面应可见');
  assert.ok(findByClass(uiRoot, 'menu')[0].classList.contains('hidden'), '主界面应隐藏');
  assert.match(matchScreen.textContent, /版本/, '匹配界面应显示版本号方便排查');

  await tick();
  const socket = app.transport.socket;
  assert.ok(socket, '应已建立 WebSocket');
  const sent = socket.messages();
  assert.equal(sent[0]?.type, 'handshake', '连上后第一条应是握手');
  assert.ok(sent[0]?.configHash, '握手要带玩法配置哈希');
  assert.equal(sent[1]?.type, 'join', '握手后应立刻请求加入快速匹配队列');
  assert.match(
    findByClass(uiRoot, 'match-status')[0].textContent,
    /已连接|等待/,
    '连上后应提示正在等待对手',
  );
});

await test('收到排队/配对通知后界面跟着走，取消可回主界面', async () => {
  const { app, uiRoot } = local;
  app.transport.events.emit('command', { type: 'queued', reason: 'waiting' });
  assert.match(findByClass(uiRoot, 'match-status')[0].textContent, /排队中/);

  app.transport.events.emit('command', { type: 'matched', roomId: 'room-1', seed: 20251022, seat: 'right' });
  assert.equal(app.screen, 'select', '配对成功应进入选坦');
  assert.equal(app.seat, 'right', '席位以服务端下发为准');
  assert.equal(app.remoteSeed, 20251022, '种子以服务端下发为准');

  click(menuButton(uiRoot, '返回'));
  assert.equal(app.screen, 'menu', '选坦返回应回到主界面');
  assert.equal(app.transport, null, '回主界面应断开远端连接');
});

await test('服务端换了构建就提示刷新，点一下真的刷新', async () => {
  documentShim._bySelector.set('meta[name="app-version"]', { getAttribute: () => '0.1.0' });
  documentShim._bySelector.set('meta[name="app-build"]', { getAttribute: () => 'localbuild' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '0.2.0', gitCommit: 'abc1234', build: 'serverbuild' }),
  });
  windowShim.reloaded = 0;

  try {
    const { app, uiRoot } = bootApp(DETERMINISTIC_URL);
    await tick(10);
    const banner = findByClass(uiRoot, 'update-banner')[0];
    assert.ok(banner, '服务端构建指纹不同时应弹出更新提示');
    assert.match(banner.textContent, /发现新版本/);
    banner.dispatch('click');
    assert.equal(windowShim.reloaded, 1, '点提示应刷新页面拿最新资源');
    assert.equal(app.screen, 'menu', '提示不应打断当前流程');
  } finally {
    globalThis.fetch = originalFetch;
    documentShim._bySelector.delete('meta[name="app-version"]');
    documentShim._bySelector.delete('meta[name="app-build"]');
  }
});

await test('版本一致时不打扰玩家', async () => {
  documentShim._bySelector.set('meta[name="app-version"]', { getAttribute: () => '0.2.0' });
  documentShim._bySelector.set('meta[name="app-build"]', { getAttribute: () => 'samebuild' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '0.2.0', gitCommit: 'abc1234', build: 'samebuild' }),
  });

  try {
    const { uiRoot } = bootApp(DETERMINISTIC_URL);
    await tick(10);
    assert.equal(findByClass(uiRoot, 'update-banner').length, 0, '版本一致不该弹提示');
  } finally {
    globalThis.fetch = originalFetch;
    documentShim._bySelector.delete('meta[name="app-version"]');
    documentShim._bySelector.delete('meta[name="app-build"]');
  }
});

section('选坦界面');

await test('进入选坦，双方选好后下一步进入战斗', () => {
  const { app, uiRoot } = local;
  click(menuButton(uiRoot, '本地双人游玩'));
  assert.equal(app.screen, 'select');
  const select = findByClass(uiRoot, 'select')[0];
  assert.ok(select && !select.classList.contains('hidden'), '选坦界面应可见');
  assert.ok(findByClass(uiRoot, 'menu')[0].classList.contains('hidden'), '主界面应隐藏');

  const leftPanel = findByClass(uiRoot, 'panel-left')[0];
  const rightPanel = findByClass(uiRoot, 'panel-right')[0];
  assert.ok(leftPanel && rightPanel, '应有两个玩家面板');
  assert.equal(leftPanel.querySelectorAll('.card').length, 3);

  const leftHammer = leftPanel.querySelectorAll('.card[data-tank-id="hammer"]')[0];
  const rightScout = rightPanel.querySelectorAll('.card[data-tank-id="scout"]')[0];
  assert.ok(leftHammer && rightScout, '找不到对应坦克卡片');
  click(leftHammer);
  click(rightScout);
  assert.ok(leftHammer.classList.contains('selected'));
  assert.ok(rightScout.classList.contains('selected'));

  const next = findByClass(uiRoot, 'next-button')[0];
  assert.equal(next.disabled, false, '双方都选好后下一步可点');
  click(next);

  assert.equal(app.screen, 'battle');
  assert.ok(app.state, '应创建对局');
  assert.equal(app.state.tanks.left.type.id, 'hammer');
  assert.equal(app.state.tanks.right.type.id, 'scout');
  assert.equal(app.turn.phase, 'move');
  const hud = findByClass(uiRoot, 'hud')[0];
  assert.ok(hud && !hud.classList.contains('hidden'), 'HUD 应显示');
  pump(5);
});

await test('镜头聚焦当前坦克', () => {
  const { app } = local;
  const tank = app.state.tanks.left;
  pump(60);
  const screen = app.camera.worldToScreen(tank.x, tank.y);
  assert.ok(Math.abs(screen.x - VIEW.width / 2) < 60, `水平未居中：${screen.x.toFixed(1)}`);
  assert.ok(Math.abs(screen.y - VIEW.height / 2) < 90, `垂直未居中：${screen.y.toFixed(1)}`);
});

await test('前方过陡：对应方向的按钮置灰并给出提示', () => {
  const { app, uiRoot } = local;
  const terrain = app.state.world.terrain;
  const backup = Float32Array.from(terrain.heights);
  const tank = app.state.tanks.left;
  const flatY = terrain.heightAt(tank.x);
  for (let i = 0; i < terrain.heights.length; i++) {
    const x = i * terrain.sampleStep;
    // 坦克右侧起一段斜率 -1.5 的上坡（超过 maxClimbSlope），左侧保持平整
    terrain.heights[i] = x < tank.x ? flatY : flatY - (x - tank.x) * 1.5;
  }
  tank.y = terrain.heightAt(tank.x);
  try {
    pump(2);
    const right = findByClass(uiRoot, 'move-right')[0];
    const leftBtn = findByClass(uiRoot, 'move-left')[0];
    const hint = findByClass(uiRoot, 'hud-hint')[0];
    assert.ok(right.classList.contains('is-blocked'), '右侧过陡时右键应置灰');
    assert.ok(!leftBtn.classList.contains('is-blocked'), '左侧可走时不应置灰');
    assert.ok(hint.textContent.includes('坡度过陡'), '提示应说明过不去：' + hint.textContent);
  } finally {
    terrain.heights.set(backup);
    pump(2);
  }
  const right = findByClass(uiRoot, 'move-right')[0];
  assert.ok(!right.classList.contains('is-blocked'), '地形恢复后按钮应恢复');
});
await test('渲染层真的在画：地形/坦克填色、文字、虚线弹道预览', () => {
  const { app, canvas } = local;
  const ctx = canvas.getContext();

  ctx.calls.clear();
  pump(2);
  assert.ok((ctx.calls.get('fill') ?? 0) > 0, '移动阶段应绘制填充图形（地形、坦克）');
  assert.ok((ctx.calls.get('stroke') ?? 0) > 0, '移动阶段应有描边');
  assert.ok((ctx.calls.get('lineTo') ?? 0) > 10, '地形应有折线采样');
  assert.ok((ctx.calls.get('fillText') ?? 0) > 0, '应绘制血量等文字');

  const origin = app.camera.worldToScreen(app.state.tanks.left.x, app.state.tanks.left.y);
  canvas.dispatch('pointerdown', { pointerId: 9, clientX: origin.x, clientY: origin.y });
  canvas.dispatch('pointermove', { pointerId: 9, clientX: origin.x - 90, clientY: origin.y + 60 });
  ctx.calls.clear();
  pump(2);
  assert.ok((ctx.calls.get('setLineDash') ?? 0) > 0, '预览线应为虚线');
  assert.ok((ctx.calls.get('lineTo') ?? 0) > 5, '预览线应包含多个采样点');

  // 拖回坦克当前所在的屏幕位置松手 → 没拉开距离，取消射击并回到移动阶段
  const pivot = app.state.tanks.left.aimPivot();
  const back = app.camera.worldToScreen(pivot.x, pivot.y);
  canvas.dispatch('pointermove', { pointerId: 9, clientX: back.x + 2, clientY: back.y + 2 });
  pump(1);
  canvas.dispatch('pointerup', { pointerId: 9 });
  pump(2);
  assert.equal(app.turn.phase, 'move', '取消瞄准后应回到移动阶段');
  assert.equal(app.state.projectile, null, '取消后不应有炮弹');
});

await test('只点一下坦克不移动，松手算取消不走火', () => {
  const { app, canvas } = local;
  const tank = app.state.tanks.left;
  const screen = app.camera.worldToScreen(tank.x, tank.y);
  canvas.dispatch('pointerdown', { pointerId: 11, clientX: screen.x, clientY: screen.y });
  assert.equal(app.turn.phase, 'aim', '按下应进入瞄准');
  pump(30);
  canvas.dispatch('pointerup', { pointerId: 11 });
  pump(2);
  assert.equal(app.turn.phase, 'move', '纯点击应回到移动阶段');
  assert.equal(app.state.projectile, null, '纯点击不应发射');
  pump(30);
});

await test('HUD 移动按钮驱动坦克并扣移动力', () => {
  const { app, uiRoot } = local;
  const right = findByClass(uiRoot, 'move-right')[0];
  assert.ok(right, '找不到右移按钮');
  const before = app.state.tanks.left.x;
  const beforePoints = app.state.tanks.left.movePointsLeft;
  right.dispatch('pointerdown');
  pump(30);
  windowShim.dispatch('pointerup');
  assert.ok(app.state.tanks.left.x > before + 20, `坦克未移动：${app.state.tanks.left.x - before}`);
  assert.ok(app.state.tanks.left.movePointsLeft < beforePoints, '移动力未扣除');
  const moveText = findByClass(uiRoot, 'move-text')[0];
  assert.match(moveText.textContent, /移动力 \d+ \/ \d+/);
});

await test('按住坦克拖拽进入瞄准，镜头拉远到能同时看到两辆坦克', () => {
  const { app, canvas } = local;
  const tank = app.state.tanks.left;
  const screen = app.camera.worldToScreen(tank.x, tank.y);
  lastPressScreen = { ...screen };
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: screen.x, clientY: screen.y });
  assert.equal(app.turn.phase, 'aim', '按在坦克上应进入瞄准');
  pump(60);

  const leftOnScreen = app.camera.worldToScreen(app.state.tanks.left.x, app.state.tanks.left.y);
  const rightOnScreen = app.camera.worldToScreen(app.state.tanks.right.x, app.state.tanks.right.y);
  for (const [name, p] of [['左车', leftOnScreen], ['右车', rightOnScreen]]) {
    assert.ok(p.x >= 0 && p.x <= VIEW.width, `${name} 不在视野内：x=${p.x.toFixed(1)}`);
    assert.ok(p.y >= -40 && p.y <= VIEW.height, `${name} 不在视野内：y=${p.y.toFixed(1)}`);
  }
});

await test('瞄准取景：力度圆整圆都在屏幕内（手机竖屏也能拉满角度与力度）', () => {
  const { app } = local;
  pump(120);
  const expectedRadius = aimDragRadiusPx(VIEW.width, VIEW.height);
  assert.equal(app.turn.aim.maxDragPixels, expectedRadius, '力度圆半径应随视口收缩');

  const pivot = app.state.tanks.left.aimPivot();
  const center = app.camera.worldToScreen(pivot.x, pivot.y);
  const margin = 1;
  assert.ok(center.x - expectedRadius >= -margin, `圆左边出屏：${(center.x - expectedRadius).toFixed(1)}`);
  assert.ok(center.x + expectedRadius <= VIEW.width + margin, `圆右边出屏：${(center.x + expectedRadius).toFixed(1)}`);
  assert.ok(center.y - expectedRadius >= -margin, `圆上边出屏：${(center.y - expectedRadius).toFixed(1)}`);
  assert.ok(center.y + expectedRadius <= VIEW.height + margin, `圆下边出屏：${(center.y + expectedRadius).toFixed(1)}`);

  const opp = app.camera.worldToScreen(app.state.tanks.right.x, app.state.tanks.right.y);
  const oppPad = CONFIG.camera.aimOpponentPadding;
  assert.ok(opp.x >= -margin && opp.x <= VIEW.width + margin, `对手不在视野内：x=${opp.x.toFixed(1)}`);
  assert.ok(opp.y >= -margin && opp.y <= VIEW.height + margin, `对手不在视野内：y=${opp.y.toFixed(1)}`);
  assert.ok(
    Math.min(opp.x, VIEW.width - opp.x) >= oppPad - margin,
    `对手贴边太近：x=${opp.x.toFixed(1)}`,
  );
});

await test('拖拽产生轨迹预览，松手后发射并受风力影响', () => {
  const { app, canvas } = local;
  const aim = app.camera.worldToScreen(app.state.tanks.left.x, app.state.tanks.left.y);
  const dragTo = { x: aim.x - 90, y: aim.y + 60 };
  canvas.dispatch('pointermove', { pointerId: 1, clientX: dragTo.x, clientY: dragTo.y });
  pump(1);
  assert.ok(app.turn.aim.state.power > 0.2, '拖拽应蓄力');
  // 力度必须等于“指针到坦克瞄准基准点”的当前屏幕距离，而不是按下瞬间的快照
  const pivot = app.state.tanks.left.aimPivot();
  const pivotScreen = app.camera.worldToScreen(pivot.x, pivot.y);
  const expected = Math.hypot(dragTo.x - pivotScreen.x, dragTo.y - pivotScreen.y);
  assert.ok(Math.abs(app.turn.aim.state.dragPixels - expected) < 1,
    `拖拽距离应以坦克为原点：${app.turn.aim.state.dragPixels.toFixed(1)} vs ${expected.toFixed(1)}`);
  // 镜头拉远后坦克已经不在按下时的位置，说明原点确实跟着坦克实时更新
  const drift = Math.hypot(pivotScreen.x - lastPressScreen.x, pivotScreen.y - lastPressScreen.y);
  assert.ok(drift > 1, `瞄准后坦克应随镜头移动（位移 ${drift.toFixed(1)}px）`);
  const stale = Math.hypot(dragTo.x - lastPressScreen.x, dragTo.y - lastPressScreen.y);
  assert.ok(Math.abs(app.turn.aim.state.dragPixels - stale) > 1, '不应沿用按下瞬间的快照距离');
  const preview = app.turn.preview;
  assert.ok(preview && preview.points.length > 3, '应有弹道预览线');

  canvas.dispatch('pointerup', { pointerId: 1 });
  assert.equal(app.turn.phase, 'resolving');
  assert.ok(app.state.projectile, '应生成炮弹');

  let frames = 0;
  while (app.turn.phase === 'resolving' && frames < 1200) {
    pump(1);
    frames += 1;
  }
  assert.notEqual(app.turn.phase, 'resolving', '炮弹应在限定时间内结算');
  assert.ok(frames > 5, '炮弹应有飞行过程');
});

await test('结算后轮换到右边玩家并重置移动力', () => {
  const { app } = local;
  let frames = 0;
  while (app.turn.phase === 'impact' && frames < 600) {
    pump(1);
    frames += 1;
  }
  assert.equal(app.state.activePlayerId, 'right');
  assert.equal(app.turn.phase, 'move');
  assert.equal(app.state.tanks.right.movePointsLeft, app.state.tanks.right.maxMovePoints);
  const chip = findByClass(local.uiRoot, 'chip-turn')[0];
  assert.equal(chip.textContent, '右边玩家回合');
});

await test('一方归零后弹出胜利弹窗，确认回到主界面', async () => {
  const { app, uiRoot } = local;
  app.state.tanks.right.hp = 1;
  // 轮到左边：用与实弹相同的积分器解一发命中弹
  let guard = 0;
  while (app.state.activePlayerId !== 'left' && guard < 8) {
    app.turn.setMoveDirection(0);
    app.turn.beginAim();
    app.turn.aim.state.power = 0.4;
    app.turn.aim.state.angleDeg = 45;
    app.turn.aim.state.dirSign = app.state.activeTank.facing;
    app.turn.releaseAim();
    let frames = 0;
    while (app.turn.phase !== 'move' && app.turn.phase !== 'gameOver' && frames < 2000) {
      pump(1);
      frames += 1;
    }
    guard += 1;
  }
  assert.equal(app.state.activePlayerId, 'left', '应轮到左边玩家');

  const solution = solveShot(app.state);
  assert.ok(solution, '应能解出命中弹');
  app.turn.applyRemoteShot(solution.angleDeg, solution.power, solution.dirSign);
  let frames = 0;
  while (app.screen !== 'result' && frames < 3000) {
    pump(1);
    frames += 1;
  }
  assert.equal(app.screen, 'result');
  assert.equal(app.state.tanks.right.hp, 0);

  const result = findByClass(uiRoot, 'result')[0];
  assert.ok(!result.classList.contains('hidden'), '结算界面应可见');
  assert.equal(findByClass(result, 'result-title')[0].textContent, '左边玩家胜利');
  assert.match(findByClass(result, 'result-detail')[0].textContent, /共 \d+ 回合/);

  click(findByClass(result, 'primary-button')[0]);
  assert.equal(app.screen, 'menu');
  assert.equal(app.state, null);
  assert.ok(!findByClass(uiRoot, 'menu')[0].classList.contains('hidden'), '应回到主界面');
});

// ------------------------------------------------------------------ 远端
section('远端接口契约');

await test('自己回合本地操作，对方回合锁输入并按命令回放', async () => {
  const a = bootApp(`${DETERMINISTIC_URL}&mode=remote&seat=left&net=broadcast&room=domtest`);
  const b = bootApp(`${DETERMINISTIC_URL}&mode=remote&seat=right&net=broadcast&room=domtest`);
  assert.equal(a.app.mode, 'remote');
  assert.equal(b.app.mode, 'remote');
  assert.equal(b.app.seat, 'right');

  // 两个标签页都点“远端对战（快速匹配）”；URL 带 net=broadcast 时走同浏览器对联通道，
  // 跳过服务器匹配，其余流程与真实远端完全一致。
  windowShim.location.search = '?mode=remote&seat=left&net=broadcast&room=domtest';
  click(menuButton(a.uiRoot, '远端对战（快速匹配）'));
  windowShim.location.search = '?mode=remote&seat=right&net=broadcast&room=domtest';
  click(menuButton(b.uiRoot, '远端对战（快速匹配）'));
  assert.equal(a.app.screen, 'select');
  assert.equal(b.app.screen, 'select');
  await tick();

  // A 选左席（自己），B 的右席由自己选；选择通过通道同步
  const pickCard = (root, panel, tankId) =>
    findByClass(root, panel)[0].querySelectorAll(`.card[data-tank-id="${tankId}"]`)[0];
  click(pickCard(a.uiRoot, 'panel-left', 'hammer'));
  click(pickCard(b.uiRoot, 'panel-right', 'scout'));
  await tick();
  assert.equal(b.app.select.getPicks().left, 'hammer', '对方的选择应同步到本地');

  // 两端都点下一步只上报“已就绪”，开局要等服务端的 start（这条通道里由本用例代发）
  const sentBy = new Map();
  for (const side of [a, b]) {
    const original = side.app.transport.send.bind(side.app.transport);
    const log = [];
    sentBy.set(side, log);
    side.app.transport.send = (command) => {
      log.push(command);
      original(command);
    };
  }
  windowShim.location.search = '?mode=remote&seat=left&net=broadcast&room=domtest';
  click(findByClass(a.uiRoot, 'next-button')[0]);
  windowShim.location.search = '?mode=remote&seat=right&net=broadcast&room=domtest';
  click(findByClass(b.uiRoot, 'next-button')[0]);
  await tick(20);
  assert.equal(a.app.screen, 'select', '只就绪不应自己开局');
  assert.ok(sentBy.get(a).some((m) => m.type === 'ready'), 'A 应上报就绪');
  assert.ok(sentBy.get(b).some((m) => m.type === 'ready'), 'B 应上报就绪');
  for (const side of [a, b]) {
    side.app.transport.events.emit('command', {
      type: 'start',
      seed: 20251022,
      picks: { left: 'hammer', right: 'scout' },
    });
  }
  await tick(20);

  assert.equal(a.app.screen, 'battle');
  assert.equal(b.app.screen, 'battle');
  assert.equal(a.app.state.tanks.left.type.id, 'hammer');
  assert.equal(b.app.state.tanks.left.type.id, 'hammer', '两端坦克选择应一致');
  assert.equal(b.app.state.tanks.right.type.id, 'scout');
  assert.equal(a.app.state.seed, b.app.state.seed, '两端必须用同一个种子');
  assert.equal(a.app.state.tanks.right.x, b.app.state.tanks.right.x, '两端地形应一致');

  // 左方回合：A 可操作，B 被锁
  assert.equal(a.app.turn.inputLocked, false);
  assert.equal(b.app.turn.inputLocked, true);
  assert.equal(b.app.turn.acceptsInput, false);
  const bMove = findByClass(b.uiRoot, 'move-right')[0];
  pump(2);
  assert.equal(bMove.disabled, true, '对方回合移动按钮应禁用');

  const bBefore = b.app.state.tanks.left.x;
  bMove.dispatch('pointerdown');
  pump(20);
  assert.equal(b.app.state.tanks.left.x, bBefore, '锁定端不应因本地输入移动');

  // A 本地移动 → 广播 → B 回放
  const aRight = findByClass(a.uiRoot, 'move-right')[0];
  const aBefore = a.app.state.tanks.left.x;
  aRight.dispatch('pointerdown');
  pump(30);
  windowShim.dispatch('pointerup');
  pump(5);
  await tick(20);
  assert.ok(a.app.state.tanks.left.x > aBefore + 15, 'A 端坦克应移动');
  const aX = a.app.state.tanks.left.x;
  let frames = 0;
  while (Math.abs(b.app.state.tanks.left.x - aX) > 1 && frames < 600) {
    pump(1);
    frames += 1;
  }
  assert.ok(Math.abs(b.app.state.tanks.left.x - aX) <= 1,
    `B 端回放后位置应一致：${b.app.state.tanks.left.x.toFixed(1)} vs ${aX.toFixed(1)}`);

  // A 发射 → 广播 → B 复现同一发弹道
  const screen = a.app.camera.worldToScreen(a.app.state.tanks.left.x, a.app.state.tanks.left.y);
  a.canvas.dispatch('pointerdown', { pointerId: 7, clientX: screen.x, clientY: screen.y });
  a.canvas.dispatch('pointermove', { pointerId: 7, clientX: screen.x - 100, clientY: screen.y + 40 });
  pump(1);
  a.canvas.dispatch('pointerup', { pointerId: 7 });
  pump(2);
  await tick(20);

  assert.ok(a.app.state.projectile, 'A 端应发射');
  assert.ok(b.app.state.projectile, 'B 端应复现发射');
  const aVel = a.app.state.projectile.launchVelocity;
  const bVel = b.app.state.projectile.launchVelocity;
  assert.ok(Math.hypot(aVel.x - bVel.x, aVel.y - bVel.y) < 1e-6,
    `两端初速应一致 ${JSON.stringify(aVel)} vs ${JSON.stringify(bVel)}`);

  frames = 0;
  while (a.app.turn.phase !== 'move' && frames < 2000) {
    pump(1);
    frames += 1;
  }
  frames = 0;
  while (b.app.turn.phase !== 'move' && frames < 2000) {
    pump(1);
    frames += 1;
  }
  assert.equal(a.app.state.activePlayerId, 'right');
  assert.equal(b.app.state.activePlayerId, 'right', '两端回合应同步切换');
  assert.equal(b.app.turn.inputLocked, false, '轮到自己时解锁');
  assert.equal(a.app.turn.inputLocked, true, '对方回合应锁定');

  a.app.dispose();
  b.app.dispose();
  local.app.dispose();
});

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
  process.exit(1);
}
