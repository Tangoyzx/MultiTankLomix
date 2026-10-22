/**
 * 零依赖浏览器验收：直接通过 CDP 驱动 Chromium（Node 内置 WebSocket）。
 * 覆盖主界面 → 选坦 → 移动 → 拖拽瞄准 → 发射结算 → 换手 → 胜利弹窗 → 返回主界面，
 * 以及远端模式下“对手回合屏蔽本地输入 + 回放对方指令”。
 *
 * 用法： node tools/webtest.mjs [--headful] [--port 4173]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 可用环境变量 CHROME_PATH 指定别的浏览器（不同机器 playwright 版本号不同）。
const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Users\\zhanxinyang\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe';
const PORT = 4173;
const CDP_PORT = 9333;
const VIEWPORT = { width: 390, height: 844 };
const SHOT_DIR = process.env.TANK_SHOT_DIR ?? join(tmpdir(), 'multitank-shots');

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnLogged(file, args, options) {
  const child = spawn(file, args, options);
  child.on('error', (error) => console.log(`[spawn 失败] ${file} → ${error.code ?? error.message}`));
  return child;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.method ?? ''} ${JSON.stringify(msg.error)}`)) : res(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    cdp.consoleErrors = [];
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      cdp.consoleErrors.push(`exception: ${d.text ?? ''} ${d.exception?.description ?? ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') cdp.consoleErrors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') cdp.consoleErrors.push(`log: ${p.entry.text}`);
    });
    return cdp;
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async evalFn(fn, ...args) {
    const serialized = args.map((a) => JSON.stringify(a)).join(',');
    return this.evaluate(`(${fn.toString()})(${serialized})`);
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  }

  async goto(url) {
    const loaded = new Promise((res) => {
      const off = (p) => {
        if (p.frameId) return;
      };
      this.on('Page.loadEventFired', res);
    });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(5000)]);
    await sleep(500);
  }

  async rect(selector) {
    return this.evalFn((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }, selector);
  }

  async click(selector) {
    const r = await this.rect(selector);
    if (!r) throw new Error(`找不到元素 ${selector}`);
    await this.mouse('mousePressed', r.x, r.y);
    await sleep(60);
    await this.mouse('mouseReleased', r.x, r.y);
    await sleep(120);
  }

  async mouse(type, x, y, button = 'left') {
    const buttons = type === 'mouseReleased' ? 0 : 1;
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons,
      clickCount: type === 'mousePressed' ? 1 : 0,
      pointerType: 'mouse',
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

async function waitFor(fn, { timeout = 8000, interval = 100, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

/** 页面里的“瞄准求解器”：用与实弹同一套无风积分，搜出能命中对手的角度/力度。 */
const AIMBOT = async function () {
  const app = window.__tankApp;
  const { previewPath } = await import('/game/Ballistics.js');
  const { CONFIG } = await import('/config.js');
  const state = app.state;
  const tank = state.activeTank;
  const foe = state.opponentTank;
  const sign = foe.x >= tank.x ? 1 : -1;
  const ctx = {
    gravity: CONFIG.physics.gravity,
    windAccel: 0,
    subStep: CONFIG.physics.projectileSubStep,
    airDrag: CONFIG.physics.airDrag,
    killBounds: state.world.derived.killBounds,
    terrain: state.world.terrain,
    targets: [],
    ignoreTargetId: null,
    graceSeconds: 0,
  };
  let best = null;
  for (let a = tank.type.minAngleDeg; a <= tank.type.maxAngleDeg; a += 1) {
    for (let p = 0.12; p <= 1.0001; p += 0.02) {
      tank.aiming = true;
      tank.aimAngleDeg = a;
      tank.aimDirSign = sign;
      const origin = tank.muzzle();
      const rad = (a * Math.PI) / 180;
      const speed = p * tank.type.maxLaunchSpeed;
      const velocity = { x: Math.cos(rad) * speed * sign, y: -Math.sin(rad) * speed };
      const { points, hit } = previewPath(origin, velocity, ctx, 3, 2, 400);
      let closest = Infinity;
      let closestIndex = -1;
      for (let i = 0; i < points.length; i++) {
        const d = Math.hypot(points[i].x - foe.x, points[i].y - (foe.y - 12));
        if (d < closest) {
          closest = d;
          closestIndex = i;
        }
      }
      const blocked = hit && hit.kind === 'terrain' && closestIndex >= points.length - 2;
      if (!blocked && closest < (best?.closest ?? 20)) best = { angle: a, power: p, closest, sign };
    }
  }
  tank.aiming = false;
  if (!best) return null;
  const turn = app.turn;
  turn.beginAim();
  turn.aim.state.angleDeg = best.angle;
  turn.aim.state.power = best.power;
  turn.aim.state.dirSign = best.sign;
  tank.aiming = true;
  tank.aimAngleDeg = best.angle;
  tank.aimPower = best.power;
  tank.aimDirSign = best.sign;
  turn.releaseAim();
  return { angle: best.angle, power: best.power, closest: best.closest };
};

const snapshot = function () {
  const app = window.__tankApp;
  const state = app.state;
  const turn = app.turn;
  return {
    screen: app.screen,
    phase: turn?.phase ?? null,
    active: state?.activePlayerId ?? null,
    locked: turn?.inputLocked ?? null,
    left: state ? { x: state.tanks.left.x, y: state.tanks.left.y, hp: state.tanks.left.hp, move: state.tanks.left.movePointsLeft, rot: state.tanks.left.rotation } : null,
    right: state ? { x: state.tanks.right.x, y: state.tanks.right.y, hp: state.tanks.right.hp, move: state.tanks.right.movePointsLeft, rot: state.tanks.right.rotation } : null,
    wind: state?.world.wind.level ?? null,
    zoom: app.camera.zoom,
    camX: app.camera.x,
    turnCount: state?.turnCount ?? 0,
  };
};

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  rmSync(SHOT_DIR, { recursive: true, force: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`截图目录：${SHOT_DIR}`);

  const server = spawnLogged(process.execPath, [resolve('tools/serve.mjs'), 'dist'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  await sleep(800);
  const probe = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status).catch((e) => `fail ${e.message}`);
  console.log(`静态服务状态：${probe}`);

  const profile = mkdtempSync(join(tmpdir(), 'tank-chrome-'));
  const chrome = spawnLogged(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', (d) => console.log(`[chrome] ${String(d).trim().slice(0, 300)}`));
  chrome.stdout.on('data', (d) => console.log(`[chrome] ${String(d).trim().slice(0, 300)}`));

  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json());
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Chromium 未能在预期时间内启动');

  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 2,
    mobile: true,
  });

  try {
    await runScenarios(cdp);
  } finally {
    check('运行期间无 JS 报错', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 4).join(' | '));
    cdp.close();
    chrome.kill();
    server.kill();
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${results.length - failures}/${results.length} 项通过`);
  if (failures > 0) process.exitCode = 1;
}

async function runScenarios(cdp) {
  // 1. 主界面
  await cdp.goto(`http://127.0.0.1:${PORT}/?wind=0`);
  await waitFor(() => cdp.evaluate('!!window.__tankApp'), { label: '应用启动' });
  const menu = await cdp.evaluate(`(() => {
    const m = document.querySelector('.menu');
    const btns = Array.from(document.querySelectorAll('.menu button'));
    return {
      visible: m && !m.classList.contains('hidden'),
      buttons: btns.map((b) => ({ text: b.textContent, disabled: b.disabled })),
    };
  })()`);
  check('主界面可见', menu.visible === true);
  const localBtn = menu.buttons.find((b) => b.text.includes('本地双人'));
  const remoteBtn = menu.buttons.find((b) => b.text.includes('远端多人'));
  check('本地双人按钮可点', localBtn && localBtn.disabled === false);
  check('远端多人按钮置灰', remoteBtn && remoteBtn.disabled === true);
  await cdp.shot('01-menu');

  // 2. 选坦界面
  await cdp.click('.menu .primary-button');
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.select')?.classList.contains('hidden')`)) === false, {
    label: '进入选坦界面',
  });
  const cards = await cdp.evaluate(`Array.from(document.querySelectorAll('.card')).length`);
  check('三款坦克 × 两位玩家共 6 张卡', cards === 6, `实际 ${cards}`);
  await cdp.click('.panel-left .card[data-tank-id="hammer"]');
  await cdp.click('.panel-right .card[data-tank-id="scout"]');
  const selected = await cdp.evaluate(`Array.from(document.querySelectorAll('.card.selected')).map((c) => c.dataset.playerId + ':' + c.dataset.tankId).sort().join(',')`);
  check('双方分别选中重锤/游骑兵', selected === 'left:hammer,right:scout', selected);
  await cdp.shot('02-select');

  // 3. 进入战斗
  await cdp.click('.next-button');
  await waitFor(async () => (await cdp.evaluate(`window.__tankApp.screen`)) === 'battle', { label: '进入战斗' });
  const s0 = await cdp.evalFn(snapshot);
  check('开局轮到左边玩家，阶段为移动', s0.active === 'left' && s0.phase === 'move', `${s0.active}/${s0.phase}`);
  check('两辆坦克分处地图两侧', s0.left.x < 300 && s0.right.x > 780, `left.x=${s0.left.x.toFixed(0)} right.x=${s0.right.x.toFixed(0)}`);
  check('风档按 URL 固定为 0', s0.wind === 0, `wind=${s0.wind}`);
  check('坦克类型生效（重锤 140/游骑兵 80）', s0.left.hp === 140 && s0.right.hp === 80, `${s0.left.hp}/${s0.right.hp}`);
  check('车身按地形倾斜（rotation 非全零）', Math.abs(s0.left.rot) + Math.abs(s0.right.rot) > 1e-6);
  await sleep(600);
  await cdp.shot('03-battle-move');

  // 4. 移动阶段：按住右键
  const before = await cdp.evalFn(snapshot);
  const moveRect = await cdp.rect('.move-right');
  await cdp.mouse('mousePressed', moveRect.x, moveRect.y);
  await sleep(900);
  await cdp.shot('04-moving');
  await cdp.mouse('mouseReleased', moveRect.x, moveRect.y);
  await sleep(300);
  const after = await cdp.evalFn(snapshot);
  check('按右键后坦克向右移动', after.left.x > before.left.x + 20, `Δx=${(after.left.x - before.left.x).toFixed(1)}`);
  check('移动消耗移动力', after.left.move < before.left.move - 20, `${before.left.move.toFixed(0)} → ${after.left.move.toFixed(0)}`);
  check('移动后仍贴合地形', Math.abs(after.left.y - (await cdp.evaluate('window.__tankApp.state.world.terrain.heightAt(window.__tankApp.state.tanks.left.x)'))) < 1.5);

  // 5. 拖拽瞄准
  const tankScreen = await cdp.evaluate(`(() => {
    const app = window.__tankApp;
    const t = app.state.activeTank;
    const p = app.camera.worldToScreen(t.x, t.y);
    return { x: p.x, y: p.y };
  })()`);
  const zoomBefore = (await cdp.evalFn(snapshot)).zoom;
  await cdp.mouse('mousePressed', tankScreen.x, tankScreen.y);
  await sleep(120);
  await cdp.mouse('mouseMoved', tankScreen.x - 60, tankScreen.y + 40);
  await sleep(80);
  await cdp.mouse('mouseMoved', tankScreen.x - 150, tankScreen.y + 90);
  await sleep(250);
  const aiming = await cdp.evaluate(`(() => {
    const app = window.__tankApp;
    return {
      phase: app.turn.phase,
      angle: app.turn.aim.state.angleDeg,
      power: app.turn.aim.state.power,
      dirSign: app.turn.aim.state.dirSign,
      preview: app.turn.preview ? app.turn.preview.points.length : 0,
    };
  })()`);
  check('按住坦克拖拽进入瞄准阶段', aiming.phase === 'aim', aiming.phase);
  check('拖拽方向决定发射角与力度', aiming.angle > 0 && aiming.power > 0.3, `angle=${aiming.angle.toFixed(1)} power=${aiming.power.toFixed(2)}`);
  check('瞄准阶段有弹道预览线', aiming.preview > 3, `${aiming.preview} 个采样点`);
  await sleep(700);
  const zoomAim = (await cdp.evalFn(snapshot)).zoom;
  check('瞄准时镜头拉远（能同时看到两辆坦克）', zoomAim < zoomBefore, `zoom ${zoomBefore.toFixed(3)} → ${zoomAim.toFixed(3)}`);
  await cdp.shot('05-aiming');

  // 6. 松手发射 → 结算 → 换手
  await cdp.mouse('mouseReleased', tankScreen.x - 150, tankScreen.y + 90);
  await waitFor(async () => ['resolving', 'impact'].includes(await cdp.evaluate('window.__tankApp.turn.phase')), {
    label: '进入炮弹飞行',
  });
  await cdp.shot('06-flight');
  await waitFor(async () => (await cdp.evaluate('window.__tankApp.state.activePlayerId')) === 'right', {
    timeout: 15000,
    label: '换到右边玩家',
  });
  const s1 = await cdp.evalFn(snapshot);
  check('子弹结算后换到右边玩家', s1.active === 'right', s1.active);
  check('新回合移动力已重置', s1.right.move > 0, `${s1.right.move}`);
  await cdp.shot('07-right-turn');

  // 7. 用真实弹道求解放一炮命中，验证扣血与回合推进
  await cdp.evaluate('window.__tankApp.state.tanks.left.hp = 40');
  const aim = await cdp.evalFn(AIMBOT);
  check('求解出命中左边的射击参数', aim !== null, aim ? `角度 ${aim.angle}° 力度 ${(aim.power * 100).toFixed(0)}%` : '未找到');
  await waitFor(async () => (await cdp.evaluate('window.__tankApp.state.tanks.left.hp')) < 40, {
    timeout: 15000,
    label: '命中后扣血',
  });
  const s2 = await cdp.evalFn(snapshot);
  check('命中对方坦克后扣除生命值', s2.left.hp < 40, `40 → ${s2.left.hp}`);
  await cdp.shot('08-hit');

  // 8. 打到分出胜负 → 胜利弹窗 → 返回主界面
  await cdp.evaluate('window.__tankApp.state.tanks.right.hp = 25');
  await waitFor(async () => (await cdp.evaluate('window.__tankApp.state.activePlayerId')) === 'left', {
    timeout: 15000,
    label: '轮到左边玩家',
  });
  await cdp.evalFn(AIMBOT);
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.result')?.classList.contains('hidden')`)) === false, {
    timeout: 20000,
    label: '弹出胜利界面',
  });
  const result = await cdp.evaluate(`(() => {
    const root = document.querySelector('.result');
    return {
      title: root.querySelector('.result-title').textContent,
      detail: root.querySelector('.result-detail').textContent,
      hasConfirm: !!Array.from(root.querySelectorAll('button')).find((b) => b.textContent.includes('确认')),
    };
  })()`);
  check('胜利界面显示“左边/右边玩家胜利”', /^(左边|右边)玩家胜利$/.test(result.title), result.title);
  check('胜利界面有确认按钮', result.hasConfirm);
  await cdp.shot('09-result');

  await cdp.click('.result .primary-button');
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.menu')?.classList.contains('hidden')`)) === false, {
    label: '返回主界面',
  });
  check('确认后回到主界面', (await cdp.evaluate('window.__tankApp.screen')) === 'menu');
  await cdp.shot('10-back-to-menu');

  // 9. 远端模式：对手回合屏蔽本地输入，但能回放对方指令
  await cdp.goto(`http://127.0.0.1:${PORT}/?wind=0&mode=remote&seat=right&net=broadcast&room=autotest`);
  await waitFor(() => cdp.evaluate('!!window.__tankApp'), { label: '远端模式启动' });
  await cdp.click('.menu .primary-button');
  await waitFor(async () => (await cdp.evaluate(`document.querySelector('.select')?.classList.contains('hidden')`)) === false, {
    label: '远端进入选坦界面',
  });
  const lockedPanel = await cdp.evaluate(`document.querySelector('.panel-left').classList.contains('panel-locked')`);
  check('远端模式锁定对方席位的选择', lockedPanel === true);
  await cdp.click('.next-button');
  await waitFor(async () => (await cdp.evaluate('window.__tankApp.screen')) === 'battle', { label: '远端进入战斗' });
  const r0 = await cdp.evalFn(snapshot);
  check('对手回合锁定本地输入', r0.locked === true && r0.active === 'left', `locked=${r0.locked} active=${r0.active}`);
  const disabled = await cdp.evaluate(`Array.from(document.querySelectorAll('.move-button')).every((b) => b.disabled)`);
  check('对手回合移动按钮被禁用', disabled === true);
  const phaseChip = await cdp.evaluate(`document.querySelector('.hud-top .chip:nth-child(2)').textContent`);
  check('HUD 提示等待对方操作', phaseChip.includes('等待对方'), phaseChip);
  await cdp.shot('11-remote-locked');

  const xBefore = (await cdp.evalFn(snapshot)).left.x;
  await cdp.evaluate(`window.__tankApp.onRemoteCommand({ type: 'move', playerId: 'left', dir: 1, distance: 70 })`);
  await sleep(1200);
  const xAfter = (await cdp.evalFn(snapshot)).left.x;
  check('回放对方的移动指令并在本地展示', xAfter > xBefore + 30, `Δx=${(xAfter - xBefore).toFixed(1)}`);

  await cdp.evaluate(`window.__tankApp.onRemoteCommand({ type: 'shot', playerId: 'left', angleDeg: 45, power: 0.85, dirSign: 1 })`);
  await waitFor(async () => ['resolving', 'impact'].includes(await cdp.evaluate('window.__tankApp.turn.phase')), {
    label: '回放对方的发射指令',
  });
  check('回放对方的发射指令', true);
  await cdp.shot('12-remote-replay');
}

main().catch((error) => {
  console.error('测试执行失败：', error);
  process.exitCode = 1;
});
