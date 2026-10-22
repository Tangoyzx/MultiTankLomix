/**
 * 无浏览器的逻辑自测：直接跑 dist/ 里已编译好的 ES 模块。
 * 用法：node tools/build.mjs && node tools/logictest.mjs
 * 覆盖：配置、地形生成、贴地朝向、移动力、弹道预览/风力、伤害结算、回合切换、远端锁输入。
 */
import assert from 'node:assert/strict';

import { aimDragRadiusPx, CONFIG, DEFAULT_CONFIG, DERIVED, derive, gameplayConfigHash } from '../dist/config.js';
import { applyUrlOverrides } from '../dist/core/configLoader.js';
import { BattleState } from '../dist/game/BattleState.js';
import { TurnController } from '../dist/game/TurnController.js';
import { MoveController } from '../dist/game/MoveController.js';
import { advance, createState, previewPath } from '../dist/game/Ballistics.js';
import { resolveDamage } from '../dist/game/DamageResolver.js';
import { Terrain } from '../dist/world/Terrain.js';
import { generateTerrain } from '../dist/world/TerrainGenerator.js';
import { Rng } from '../dist/core/rng.js';
import { TANK_VISUAL } from '../dist/entities/Tank.js';
import { Camera } from '../dist/render/Camera.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
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

const TANK_ATTRS = [
  'id',
  'name',
  'blurb',
  'hp',
  'movePoints',
  'minAngleDeg',
  'maxAngleDeg',
  'maxLaunchSpeed',
  'terrainDamageRadius',
];

// ---------------------------------------------------------------- 配置
section('配置');

test('三款坦克且属性齐全', () => {
  assert.equal(CONFIG.tanks.length, 3);
  for (const tank of CONFIG.tanks) {
    for (const key of TANK_ATTRS) assert.ok(key in tank, `缺少属性 ${key}`);
    assert.ok(tank.maxAngleDeg > tank.minAngleDeg, `${tank.id} 射界非法`);
    assert.ok(tank.hp > 0 && tank.movePoints > 0 && tank.maxLaunchSpeed > 0);
    assert.ok(tank.terrainDamageRadius > 0, '地形破坏半径需预留');
  }
  const move = CONFIG.tanks.map((t) => t.movePoints);
  assert.deepEqual([...move].sort((a, b) => a - b), move.slice().sort((a, b) => a - b));
  assert.equal(new Set(move).size, 3, '三款坦克移动力应互不相同');
  assert.equal(new Set(CONFIG.tanks.map((t) => t.hp)).size, 3, '三款坦克生命值应互不相同');
});

test('地图宽度约为竖屏手机 2~3 屏', () => {
  const screens = CONFIG.world.width / CONFIG.camera.focusViewWidth;
  assert.ok(screens >= 2 && screens <= 3, `实际 ${screens.toFixed(2)} 屏`);
});

test('配置被冻结，误改会抛错', () => {
  assert.ok(Object.isFrozen(CONFIG));
  assert.throws(() => {
    'use strict';
    CONFIG.physics.gravity = 1;
  });
});

test('URL 覆盖只认白名单，wind 别名映射到 wind.fixedLevel', () => {
  const { config, applied, rejected } = applyUrlOverrides(
    DEFAULT_CONFIG,
    DEFAULT_CONFIG.debug.allowedOverrideKeys,
    '?wind=0&world.width=1400&physics.gravity=abc&hack=1',
    { wind: 'wind.fixedLevel' },
  );
  assert.equal(config.wind.fixedLevel, 0);
  assert.equal(config.world.width, 1400);
  assert.equal(config.physics.gravity, DEFAULT_CONFIG.physics.gravity, '非法值应回退默认');
  assert.deepEqual(applied.map((a) => a.key), ['wind', 'world.width']);
  assert.deepEqual(rejected, ['physics.gravity']);
  assert.ok(!('hack' in config));
});

test('derive 派生出生点与出界边界', () => {
  const d = derive(DEFAULT_CONFIG);
  assert.ok(d.spawnX.left < CONFIG.world.width / 2);
  assert.ok(d.spawnX.right > CONFIG.world.width / 2);
  assert.ok(d.spawnX.right - d.spawnX.left > CONFIG.world.width * 0.6, '双方应分居地图两侧');
  assert.ok(d.minHeight < d.baseline && d.baseline < d.maxHeight);
  assert.equal(typeof gameplayConfigHash(), 'string');
  assert.equal(gameplayConfigHash(), gameplayConfigHash(), '配置哈希需稳定');
});

// ---------------------------------------------------------------- 地形
section('地形生成');

test('同种子一致、异种子不同', () => {
  const a = generateTerrain(CONFIG, DERIVED, new Rng(1234));
  const b = generateTerrain(CONFIG, DERIVED, new Rng(1234));
  const c = generateTerrain(CONFIG, DERIVED, new Rng(4321));
  assert.deepEqual([...a.heights], [...b.heights]);
  assert.notDeepEqual([...a.heights], [...c.heights]);
});

test('高度落在上下限内且中线附近有起伏', () => {
  const terrain = generateTerrain(CONFIG, DERIVED, new Rng(7));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < terrain.sampleCount; i++) {
    const h = terrain.heights[i];
    assert.ok(Number.isFinite(h));
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  assert.ok(min >= DERIVED.minHeight - 1e-3 && max <= DERIVED.maxHeight + 1e-3);
  assert.ok(max - min > 40, `地形起伏过小：${(max - min).toFixed(1)}`);
});

test('两侧出生平台被压平，开局不会卡在悬崖上', () => {
  const terrain = generateTerrain(CONFIG, DERIVED, new Rng(99));
  for (const x of [DERIVED.spawnX.left, DERIVED.spawnX.right]) {
    const slope = Math.abs(terrain.slopeAt(x));
    assert.ok(slope < 0.12, `出生点坡度 ${slope.toFixed(3)} 过陡`);
    assert.ok(Math.abs(terrain.heightAt(x) - DERIVED.baseline) < 12);
  }
});

test('heightAt 在边界外做钳制', () => {
  const terrain = generateTerrain(CONFIG, DERIVED, new Rng(5));
  assert.equal(terrain.heightAt(-500), terrain.heightAt(0));
  assert.equal(terrain.heightAt(CONFIG.world.width + 500), terrain.heightAt(CONFIG.world.width));
});

// ---------------------------------------------------------------- 贴地朝向
section('坦克贴地与朝向');

test('车顶方向与地表法线一致（不是恒定朝屏幕上方）', () => {
  const terrain = generateTerrain(CONFIG, DERIVED, new Rng(2024));
  let maxAbsRotation = 0;
  for (let x = 60; x < CONFIG.world.width - 60; x += 7) {
    const slope = terrain.slopeAt(x);
    const rotation = terrain.rotationAt(x);
    assert.ok(Math.abs(rotation - Math.atan(slope)) < 1e-9);
    // 车体局部 (0,-1) 即“车顶朝上”，经 rotation 旋转后应与地表法线重合
    const up = { x: Math.sin(rotation), y: -Math.cos(rotation) };
    const n = terrain.normalAt(x);
    assert.ok(Math.hypot(up.x - n.x, up.y - n.y) < 1e-9, `x=${x} 车顶与法线不一致`);
    assert.ok(n.y < 0, '法线必须朝上');
    maxAbsRotation = Math.max(maxAbsRotation, Math.abs(rotation));
  }
  assert.ok(maxAbsRotation > 0.15, `朝向几乎没变化（${maxAbsRotation.toFixed(3)} rad），地形可能没生效`);
});

test('syncToGround 让坦克落在地表并保持姿态', () => {
  const state = new BattleState(31, { left: 'scout', right: 'hammer' });
  for (const id of ['left', 'right']) {
    const tank = state.tanks[id];
    assert.ok(Math.abs(tank.y - state.world.terrain.heightAt(tank.x)) < 1e-6);
    assert.ok(Math.abs(tank.rotation - state.world.terrain.rotationAt(tank.x)) < 1e-9);
  }
});

test('双方分居两侧且血量/移动力按类型初始化', () => {
  const state = new BattleState(77, { left: 'scout', right: 'hammer' });
  assert.ok(state.tanks.left.x < CONFIG.world.width / 2);
  assert.ok(state.tanks.right.x > CONFIG.world.width / 2);
  assert.equal(state.tanks.left.facing, 1);
  assert.equal(state.tanks.right.facing, -1);
  assert.equal(state.tanks.left.hp, 80);
  assert.equal(state.tanks.left.movePointsLeft, 280);
  assert.equal(state.tanks.right.hp, 140);
  assert.equal(state.tanks.right.movePointsLeft, 120);
});

// ---------------------------------------------------------------- 移动
section('移动阶段');

function moveUntilDone(tank, terrain, dir, maxFrames = 2000) {
  const move = new MoveController();
  move.dir = dir;
  let frames = 0;
  let lastX = tank.x;
  while (frames < maxFrames) {
    const arc = move.update(1 / 60, tank, null, terrain);
    frames += 1;
    if (arc === 0 && tank.x === lastX) break;
    lastX = tank.x;
  }
  return frames;
}

test('移动按弧长扣移动力，且始终贴地', () => {
  const state = new BattleState(3, { left: 'standard', right: 'standard' });
  const tank = state.tanks.left;
  const terrain = state.world.terrain;
  const startX = tank.x;
  const budget = tank.movePointsLeft;
  moveUntilDone(tank, terrain, 1);
  assert.ok(tank.x > startX + 50, `位移过小：${(tank.x - startX).toFixed(1)}`);
  assert.ok(tank.movePointsLeft >= 0 && tank.movePointsLeft < 3, `剩余移动力 ${tank.movePointsLeft.toFixed(2)}`);
  assert.ok(tank.movePointsLeft <= budget);
  assert.ok(Math.abs(tank.y - terrain.heightAt(tank.x)) < 1e-6, '移动后必须贴地');
  assert.ok(Math.abs(tank.rotation - terrain.rotationAt(tank.x)) < 1e-9, '移动后姿态需更新');
  assert.equal(tank.facing, 1, '朝右移动时朝向为右');
});

test('移动力耗尽后不再移动', () => {
  const state = new BattleState(3, { left: 'standard', right: 'standard' });
  const tank = state.tanks.left;
  const terrain = state.world.terrain;
  tank.movePointsLeft = 0;
  const move = new MoveController();
  move.dir = 1;
  const before = tank.x;
  for (let i = 0; i < 60; i++) move.update(1 / 60, tank, null, terrain);
  assert.equal(tank.x, before);
  assert.equal(move.update(1 / 60, tank, null, terrain), 0);
});

test('地图边缘不会走出去', () => {
  const state = new BattleState(9, { left: 'scout', right: 'scout' });
  const tank = state.tanks.left;
  const terrain = state.world.terrain;
  tank.x = 30;
  const edge = TANK_VISUAL.bodyWidth * 0.5 + 6;
  const move = new MoveController();
  move.dir = -1;
  for (let i = 0; i < 600; i++) move.update(1 / 60, tank, null, terrain);
  assert.ok(tank.x >= edge - 1e-6, `越出左边界：${tank.x}`);
});

test('陡坡挡住去路', () => {
  const heights = new Float32Array(400);
  for (let i = 0; i < heights.length; i++) heights[i] = 1000 - i * 8; // 斜率 4，远超 maxClimbSlope
  const terrain = new Terrain(heights, 2, 798, 1920);
  const state = new BattleState(1, { left: 'scout', right: 'scout' });
  const tank = state.tanks.left;
  tank.x = 400;
  tank.y = terrain.heightAt(400);
  const move = new MoveController();
  move.dir = 1;
  const before = tank.x;
  for (let i = 0; i < 10; i++) move.update(1 / 60, tank, null, terrain);
  assert.equal(tank.x, before, '过陡的坡应阻止移动');
});

test('下坡比上坡宽松：站在坡顶能往下开', () => {
  const heights = new Float32Array(400);
  for (let i = 0; i < heights.length; i++) heights[i] = 1000 - i * 3; // 斜率 -1.5：向右升高、向左降低
  const terrain = new Terrain(heights, 2, 798, 1920);
  const state = new BattleState(1, { left: 'scout', right: 'scout' });
  const tank = state.tanks.left;
  tank.x = 400;
  tank.y = terrain.heightAt(400);
  const move = new MoveController();

  const startX = tank.x;
  move.dir = 1; // 上坡：1.5 超过 maxClimbSlope(1)，仍应挡住
  for (let i = 0; i < 10; i++) move.update(1 / 60, tank, null, terrain);
  assert.equal(tank.x, startX, '超过 maxClimbSlope 的上坡仍应挡住');

  move.dir = -1; // 下坡：1.5 在 maxDescendSlope(2.2) 之内，应能走
  for (let i = 0; i < 10; i++) move.update(1 / 60, tank, null, terrain);
  assert.ok(tank.x < startX - 1, '下坡应该能走，实际 x=' + tank.x.toFixed(1));
  assert.equal(move.isBlocked(1, tank, terrain), true, '右侧上坡应判定为过陡');
  assert.equal(move.isBlocked(-1, tank, terrain), false, '左侧下坡不应被拦');
});
test('两车之间保持最小间距', () => {
  const state = new BattleState(11, { left: 'scout', right: 'scout' });
  const terrain = state.world.terrain;
  const left = state.tanks.left;
  const right = state.tanks.right;
  right.x = left.x + CONFIG.combat.minTankSeparation - 4;
  const move = new MoveController();
  move.dir = 1;
  const before = left.x;
  for (let i = 0; i < 30; i++) move.update(1 / 60, left, right, terrain);
  assert.equal(left.x, before, '不应贴到对方身上');
});

test('远端指令按排队距离移动', () => {
  const state = new BattleState(13, { left: 'standard', right: 'standard' });
  const tank = state.tanks.left;
  const terrain = state.world.terrain;
  const move = new MoveController();
  const startX = tank.x;
  move.queueRemote(1, 100);
  for (let i = 0; i < 600 && move.isMoving; i++) move.update(1 / 60, tank, null, terrain);
  const walked = tank.x - startX;
  assert.ok(walked > 40, `回放位移过小：${walked.toFixed(1)}`);
  assert.ok(tank.movePointsLeft < tank.maxMovePoints);
});

// ---------------------------------------------------------------- 弹道
section('射击与弹道');

function makeCtx(terrain, windAccel, targets = []) {
  return {
    gravity: CONFIG.physics.gravity,
    windAccel,
    subStep: CONFIG.physics.projectileSubStep,
    airDrag: CONFIG.physics.airDrag,
    killBounds: DERIVED.killBounds,
    terrain,
    targets,
    ignoreTargetId: null,
    graceSeconds: 0,
  };
}

test('无风时预览轨迹与真实弹道一致', () => {
  const state = new BattleState(21, { left: 'standard', right: 'standard' });
  const terrain = state.world.terrain;
  const ctx = makeCtx(terrain, 0);
  const origin = { x: 300, y: terrain.heightAt(300) - 60 };
  const velocity = { x: 260, y: -520 };
  const { points, hit } = previewPath(origin, velocity, ctx, 2.5, 4, 60);
  assert.ok(points.length > 5, '预览应有可见采样点');
  assert.ok(hit, '预览应命中地表或出界');

  const sim = createState(origin, velocity);
  let simHit = null;
  for (let i = 0; i < 400 && !simHit; i++) simHit = advance(sim, 1 / 60, ctx);
  assert.ok(simHit, '实弹应命中');
  assert.equal(simHit.kind, hit.kind);
  const gap = Math.hypot(simHit.point.x - hit.point.x, simHit.point.y - hit.point.y);
  assert.ok(gap < 0.05, `预览与实弹落点偏差 ${gap.toFixed(4)}`);
});

test('风力把弹道吹偏，且方向与风档一致', () => {
  const state = new BattleState(21, { left: 'standard', right: 'standard' });
  const terrain = state.world.terrain;
  const origin = { x: 300, y: terrain.heightAt(300) - 60 };
  const velocity = { x: 260, y: -520 };

  function land(windAccel) {
    const sim = createState(origin, velocity);
    let hit = null;
    for (let i = 0; i < 400 && !hit; i++) hit = advance(sim, 1 / 60, makeCtx(terrain, windAccel));
    return sim.pos.x;
  }
  const calm = land(0);
  const east = land(8 * CONFIG.wind.accelerationPerLevel);
  const west = land(-8 * CONFIG.wind.accelerationPerLevel);
  assert.ok(east > calm + 10, `顺风右偏不足：${(east - calm).toFixed(1)}`);
  assert.ok(west < calm - 10, `逆风左偏不足：${(calm - west).toFixed(1)}`);
});

test('子弹飞出边界判定为 out', () => {
  const state = new BattleState(21, { left: 'standard', right: 'standard' });
  const terrain = state.world.terrain;
  const ctx = makeCtx(terrain, 0);
  const sim = createState({ x: 500, y: 200 }, { x: 0, y: -3000 });
  let hit = null;
  for (let i = 0; i < 200 && !hit; i++) hit = advance(sim, 1 / 60, ctx);
  assert.equal(hit.kind, 'out');
});

test('命中判定使用坦克命中半径', () => {
  const state = new BattleState(21, { left: 'standard', right: 'standard' });
  const terrain = state.world.terrain;
  const target = { id: 'right', x: 700, y: terrain.heightAt(700) - 4, hitRadius: CONFIG.combat.tankHitRadius, alive: true };
  const sim = createState({ x: 700, y: terrain.heightAt(700) - 300 }, { x: 0, y: 600 });
  const ctx = makeCtx(terrain, 0, [target]);
  let hit = null;
  for (let i = 0; i < 200 && !hit; i++) hit = advance(sim, 1 / 60, ctx);
  assert.equal(hit.kind, 'tank');
  assert.equal(hit.targetId, 'right');
});

// ---------------------------------------------------------------- 伤害
section('伤害结算');

test('直接命中扣满额，波及按距离衰减', () => {
  const state = new BattleState(41, { left: 'standard', right: 'standard' });
  const tanks = state.tanks;
  const direct = resolveDamage(
    { kind: 'tank', point: { x: tanks.right.x, y: tanks.right.y }, targetId: 'right' },
    tanks,
    CONFIG,
  );
  assert.equal(tanks.right.hp, 100 - CONFIG.combat.directHitDamage);
  assert.equal(direct[0].direct, true);
  assert.equal(tanks.left.hp, 100, '距离足够远不应被波及');

  const before = tanks.left.hp;
  resolveDamage(
    { kind: 'terrain', point: { x: tanks.left.x + 5, y: tanks.left.y }, targetId: null },
    tanks,
    CONFIG,
  );
  const loss = before - tanks.left.hp;
  assert.ok(loss >= CONFIG.combat.splashMinDamage && loss <= CONFIG.combat.directHitDamage,
    `波及伤害异常：${loss}`);
});

test('出界不造成伤害，血量不为负', () => {
  const state = new BattleState(41, { left: 'standard', right: 'standard' });
  const tanks = state.tanks;
  assert.deepEqual(resolveDamage({ kind: 'out', point: { x: 0, y: 0 }, targetId: null }, tanks, CONFIG), []);
  tanks.right.hp = 3;
  resolveDamage({ kind: 'tank', point: { x: tanks.right.x, y: tanks.right.y }, targetId: 'right' }, tanks, CONFIG);
  assert.equal(tanks.right.hp, 0);
  assert.equal(tanks.right.alive, false);
});

// ---------------------------------------------------------------- 瞄准取景
section('瞄准取景');

test('力度圆半径按视口短边收缩，整圆放得进屏幕', () => {
  const viewports = [
    [390, 844],
    [844, 390],
    [360, 640],
    [1440, 900],
  ];
  for (const [w, h] of viewports) {
    const radius = aimDragRadiusPx(w, h);
    assert.ok(radius <= CONFIG.input.maxDragPixels, `${w}x${h} 半径不该超过上限`);
    assert.ok(radius >= Math.min(CONFIG.input.minAimRadiusPx, CONFIG.input.maxDragPixels), '半径不该低于下限');
    assert.ok(radius * 2 <= Math.min(w, h), `${w}x${h} 力度圆直径 ${radius * 2} 超过短边 ${Math.min(w, h)}`);
  }
});

test('瞄准取景：力度圆整圆在屏内，且两辆坦克都看得见', () => {
  const viewports = [
    [390, 844],
    [844, 390],
    [360, 640],
    [320, 480],
    [768, 1024],
    [1440, 900],
    [1920, 1080],
  ];
  // 覆盖：出生点、贴左右边界、贴在一起、高度差拉满。
  const pairs = [
    ['出生点', { x: DERIVED.spawnX.left, y: DERIVED.baseline }, { x: DERIVED.spawnX.right, y: DERIVED.baseline }],
    ['右侧瞄', { x: DERIVED.spawnX.right, y: DERIVED.baseline }, { x: DERIVED.spawnX.left, y: DERIVED.baseline }],
    ['贴左边界', { x: 0, y: DERIVED.minHeight }, { x: CONFIG.world.width, y: DERIVED.maxHeight }],
    ['贴右边界', { x: CONFIG.world.width, y: DERIVED.maxHeight }, { x: 0, y: DERIVED.minHeight }],
    ['贴在一起', { x: 500, y: DERIVED.baseline }, { x: 560, y: DERIVED.baseline + 28 }],
  ];
  const camera = new Camera();
  for (const [w, h] of viewports) {
    const radius = aimDragRadiusPx(w, h);
    const need = radius + CONFIG.input.aimRadiusPaddingPx;
    camera.setViewport(w, h);
    for (const [name, pivot, opponent] of pairs) {
      // 逐帧收敛，模拟真实运行时的镜头过渡
      for (let i = 0; i < 200; i++) {
        camera.frameAim(pivot, opponent, radius);
        camera.update(1 / 60);
      }
      const center = camera.worldToScreen(pivot.x, pivot.y);
      const clearance = Math.min(center.x, w - center.x, center.y, h - center.y);
      assert.ok(
        clearance >= need - 0.5,
        `${w}x${h} ${name}：圆心到边缘只有 ${clearance.toFixed(1)}px，力度圆需要 ${need}px`,
      );
      const opp = camera.worldToScreen(opponent.x, opponent.y);
      const pad = CONFIG.camera.aimOpponentPadding;
      assert.ok(
        opp.x >= pad - 1 && opp.x <= w - pad + 1 && opp.y >= pad - 1 && opp.y <= h - pad + 1,
        `${w}x${h} ${name}：对手不在安全区内 (${opp.x.toFixed(1)}, ${opp.y.toFixed(1)})`,
      );
    }
  }
});

// ---------------------------------------------------------------- 回合
section('回合流程');

function runUntilPhase(tc, predicate, maxFrames = 3000) {
  for (let i = 0; i < maxFrames; i++) {
    tc.update(1 / 60);
    if (predicate(tc)) return true;
  }
  return false;
}

test('开局：左方先手，移动阶段，镜头聚焦该坦克', () => {
  const state = new BattleState(5, { left: 'standard', right: 'standard' });
  const tc = new TurnController(state);
  const events = [];
  tc.events.on('cameraFocus', (e) => events.push(e));
  tc.start();
  assert.equal(tc.phase, 'move');
  assert.equal(state.activePlayerId, 'left');
  assert.ok(tc.canMove && tc.acceptsInput);
  assert.equal(state.tanks.left.movePointsLeft, 190);
  assert.deepEqual(events, [{ playerId: 'left' }]);
});

test('瞄准阶段：预览可用，松手发射并拉远镜头', () => {
  const state = new BattleState(5, { left: 'standard', right: 'standard' });
  state.world.wind.level = 0;
  const tc = new TurnController(state);
  const events = [];
  tc.events.on('cameraFrameBoth', () => events.push('frameBoth'));
  tc.start();
  assert.equal(tc.preview, null);
  assert.equal(tc.beginAim(), true);
  assert.equal(tc.phase, 'aim');
  assert.deepEqual(events, ['frameBoth']);

  const tank = state.activeTank;
  tc.updateAim({ x: tank.x - 60, y: tank.y - 60 }, CONFIG.input.maxDragPixels * 0.8);
  const preview = tc.preview;
  assert.ok(preview && preview.points.length > 3, '拖动时应有轨迹线');
  assert.ok(tank.aimAngleDeg >= tank.type.minAngleDeg && tank.aimAngleDeg <= tank.type.maxAngleDeg);

  tc.releaseAim();
  assert.equal(tc.phase, 'resolving');
  assert.ok(state.projectile, '应生成子弹');
  assert.ok(runUntilPhase(tc, (c) => c.phase === 'impact' || c.phase === 'gameOver'));
});

test('力度过小取消射击，回到移动阶段', () => {
  const state = new BattleState(6, { left: 'standard', right: 'standard' });
  const tc = new TurnController(state);
  tc.start();
  tc.beginAim();
  tc.updateAim({ x: state.activeTank.x - 30, y: state.activeTank.y - 30 }, 2);
  tc.releaseAim();
  assert.equal(tc.phase, 'move');
  assert.equal(state.projectile, null);
  assert.equal(state.activeTank.aiming, false);
});

test('结算完成后轮换到对方并重置移动力', () => {
  const state = new BattleState(8, { left: 'standard', right: 'standard' });
  const tc = new TurnController(state);
  const seen = [];
  tc.events.on('turnStart', (e) => seen.push(e.playerId));
  tc.start();
  tc.beginAim();
  tc.updateAim({ x: state.activeTank.x - 60, y: state.activeTank.y - 60 }, CONFIG.input.maxDragPixels);
  tc.releaseAim();
  assert.ok(runUntilPhase(tc, (c) => c.phase === 'move' && c.state.activePlayerId === 'right'));
  assert.equal(state.activePlayerId, 'right');
  assert.deepEqual(seen, ['left', 'right']);
  assert.equal(state.tanks.right.movePointsLeft, state.tanks.right.maxMovePoints);
  assert.equal(state.projectile, null);
});

// ---------------------------------------------------------------- 远端
section('远端模式');

test('对手回合锁本地输入，但能回放对方操作', () => {
  const state = new BattleState(12, { left: 'standard', right: 'standard' });
  const tc = new TurnController(state);
  tc.start();
  tc.inputLocked = true;
  assert.equal(tc.acceptsInput, false);
  assert.equal(tc.canMove, false);
  assert.equal(tc.canAim, false);

  const before = state.tanks.left.x;
  tc.setMoveDirection(1);
  assert.equal(tc.move.dir, 0, '锁定期间不应记录方向');
  for (let i = 0; i < 60; i++) tc.update(1 / 60);
  assert.equal(state.tanks.left.x, before, '锁定期间坦克不应移动');

  tc.applyRemoteMove(1, 120);
  for (let i = 0; i < 600 && tc.move.isMoving; i++) tc.update(1 / 60);
  assert.ok(state.tanks.left.x > before + 40, '远端移动指令应在本地播放');
});

test('远端发射指令在本地复现并造成伤害', () => {
  const state = new BattleState(15, { left: 'standard', right: 'standard' });
  state.world.wind.level = 0;
  const tc = new TurnController(state);
  const shots = [];
  tc.events.on('shot', (e) => shots.push(e));
  tc.start();
  tc.inputLocked = true;
  const beforeHp = state.tanks.right.hp;
  const solution = solveShot(state);
  assert.ok(solution, '应能解出一发命中弹');
  tc.applyRemoteShot(solution.angleDeg, solution.power, solution.dirSign);
  assert.equal(shots.length, 1);
  assert.equal(tc.phase, 'resolving');
  assert.ok(runUntilPhase(tc, (c) => c.phase === 'impact' || c.phase === 'gameOver'));
  assert.ok(state.tanks.right.hp < beforeHp, '命中后对方应掉血');
});

// ---------------------------------------------------------------- 整局
section('整局对轰到分出胜负');

/** 用与实弹相同的积分器暴力搜索命中解（含风）。 */
function solveShot(state) {
  const shooter = state.activeTank;
  const target = state.opponentTank;
  const ctx = {
    gravity: CONFIG.physics.gravity,
    windAccel: state.world.wind.acceleration,
    subStep: CONFIG.physics.projectileSubStep,
    airDrag: CONFIG.physics.airDrag,
    killBounds: DERIVED.killBounds,
    terrain: state.world.terrain,
    targets: state.targets(),
    ignoreTargetId: state.activePlayerId,
    graceSeconds: CONFIG.combat.selfHitGraceSeconds,
  };
  const dirSign = target.x > shooter.x ? 1 : -1;
  let best = null;
  for (let angleDeg = shooter.type.minAngleDeg; angleDeg <= shooter.type.maxAngleDeg; angleDeg += 1) {
    for (let power = 0.2; power <= 1.0; power += 0.02) {
      const speed = power * shooter.type.maxLaunchSpeed;
      const rad = (angleDeg * Math.PI) / 180;
      const velocity = { x: Math.cos(rad) * speed * dirSign, y: -Math.sin(rad) * speed };
      const sim = createState(shooter.muzzle(), velocity);
      let hit = null;
      for (let i = 0; i < 400 && !hit; i++) hit = advance(sim, 1 / 60, ctx);
      if (hit?.kind === 'tank' && hit.targetId === target.id) return { angleDeg, power, dirSign };
      const miss = hit ? Math.hypot(hit.point.x - target.x, hit.point.y - target.y) : 1e9;
      if (!best || miss < best.miss) best = { angleDeg, power, dirSign, miss };
    }
  }
  return null;
}

test('自动对轰直到一方归零，弹出胜利文案并锁定输入', () => {
  const state = new BattleState(2026, { left: 'hammer', right: 'scout' });
  const tc = new TurnController(state);
  const turns = [];
  tc.events.on('turnStart', (e) => turns.push(e.playerId));
  tc.start();

  let guard = 0;
  while (tc.phase !== 'gameOver' && guard < 60) {
    guard += 1;
    const shooterId = state.activePlayerId;
    const solution = solveShot(state);
    if (solution) {
      tc.applyRemoteShot(solution.angleDeg, solution.power, solution.dirSign);
    } else {
      tc.beginAim();
      tc.updateAim({ x: state.activeTank.x - 80, y: state.activeTank.y - 80 }, CONFIG.input.maxDragPixels);
      tc.releaseAim();
    }
    const done = runUntilPhase(
      tc,
      (c) => c.phase === 'gameOver' || (c.phase === 'move' && c.state.activePlayerId !== shooterId),
      4000,
    );
    assert.ok(done, '回合应在限定时间内结束');
  }

  assert.equal(tc.phase, 'gameOver');
  assert.ok(['left', 'right'].includes(tc.winner));
  assert.match(tc.victoryText(), /^(左边|右边)玩家胜利$/);
  const loser = tc.winner === 'left' ? 'right' : 'left';
  assert.equal(state.tanks[loser].hp, 0);
  assert.equal(tc.acceptsInput, false, '结束后不应再接受输入');

  for (let i = 0; i < turns.length - 1; i++) {
    assert.notEqual(turns[i], turns[i + 1], '回合必须交替');
  }
  const before = state.activeTank.x;
  tc.setMoveDirection(1);
  for (let i = 0; i < 60; i++) tc.update(1 / 60);
  assert.equal(state.activeTank.x, before);
});

// ---------------------------------------------------------------- 汇总
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
  process.exit(1);
}
