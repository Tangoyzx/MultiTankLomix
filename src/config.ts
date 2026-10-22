import { applyUrlOverrides, deepFreeze, stableHash } from './core/configLoader.js';
import type { PlayerId } from './core/types.js';

export interface OctaveConfig {
  wavelength: number;
  amplitude: number;
}

export interface TankTypeConfig {
  id: string;
  name: string;
  /** 一句话卖点，选坦界面用。 */
  blurb: string;
  hp: number;
  /** 每回合可移动的地表弧长（世界单位）。 */
  movePoints: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  maxLaunchSpeed: number;
  /** 备用：本版不产生地形破坏。 */
  terrainDamageRadius: number;
}

export interface BoundsMargin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface WorldConfig {
  width: number;
  height: number;
  outOfBoundsMargin: BoundsMargin;
}

export interface TerrainConfig {
  sampleStep: number;
  baselineRatio: number;
  minHeightRatio: number;
  maxHeightRatio: number;
  octaves: OctaveConfig[];
  spawnPlatform: { width: number; edgeInset: number; flatten: number; flatRatio: number };
  surfaceSkinThickness: number;
  maxClimbSlope: number;
  /** 下坡（往地形变低的方向）允许的更陡上限，避免站在坡顶就寸步难行。 */
  maxDescendSlope: number;
}

export interface PhysicsConfig {
  gravity: number;
  projectileSubStep: number;
  airDrag: number;
}

export interface WindConfig {
  minLevel: number;
  maxLevel: number;
  accelerationPerLevel: number;
  rerollEachTurn: boolean;
  /** 非 null 时固定风档，用于调试与验收（?wind=0）。 */
  fixedLevel: number | null;
}

export interface CameraPadding {
  horizontal: number;
  top: number;
  bottom: number;
}

export interface CameraConfig {
  focusViewWidth: number;
  /** 聚焦时希望看到的竖向范围，避免横屏 PC 上贴得太近。 */
  focusViewHeight: number;
  aimPadding: CameraPadding;
  /** 瞄准取景时，对手坦克与屏幕边缘至少留多少 CSS 像素。 */
  aimOpponentPadding: number;
  /** 瞄准取景允许的最小缩放（相对“整张地图刚好装下”的缩放），保证极端窄屏也能拉到需要的视角。 */
  aimZoomClampScale: number;
  zoomClampScale: number;
  followSmoothing: number;
  overscrollAllowance: number;
}

export interface TurnConfig {
  moveSpeed: number;
  impactHoldSeconds: number;
  explosionLifetime: number;
  allowAimAnyTime: boolean;
}

export interface CombatConfig {
  directHitDamage: number;
  explosionRadius: number;
  splashMinDamage: number;
  tankHitRadius: number;
  selfHitGraceSeconds: number;
  minTankSeparation: number;
}

export interface TrailConfig {
  maxSeconds: number;
  sampleEverySteps: number;
  maxPoints: number;
}

export interface InputConfig {
  /** 按在坦克周围多少 CSS 像素内才算“按住坦克”，用于进入瞄准模式。 */
  tankTapRadiusPx: number;
  /** 拖拽满力所需的像素距离；力度 = 拖拽距离 / 该值。 */
  maxDragPixels: number;
  /** 力度圆半径上限的收缩余量：圆心到屏幕边缘至少留这么多 CSS 像素。 */
  aimRadiusPaddingPx: number;
  /** 力度圆半径下限，避免超窄视口下圆小到没法瞄准。 */
  minAimRadiusPx: number;
  /** 力度低于该值视为取消（只点了一下坦克）。 */
  cancelPowerThreshold: number;
  trail: TrailConfig;
}

export interface UiConfig {
  moveButtonSizePx: number;
  safeAreaPadding: number;
  damageFloatDuration: number;
  /** 结算完成到弹出胜利界面的停顿。 */
  resultDelaySeconds: number;
}

export interface SimConfig {
  /** 固定步长，保证不同帧率下手感与弹道一致。 */
  fixedStep: number;
  maxCatchUpSteps: number;
  maxFrameSeconds: number;
}

export interface HillLayerConfig {
  parallax: number;
  amplitude: number;
  wavelength: number;
  yOffset: number;
}

export interface RenderConfig {
  maxPixelRatio: number;
  parallaxHills: HillLayerConfig[];
  projectileRadius: number;
  trailWidthPx: number;
  previewWidthPx: number;
  previewDashPx: number;
  previewGapPx: number;
  hpBarWidth: number;
  hpBarHeight: number;
  hpBarOffsetY: number;
  activeRingRadius: number;
}

export interface DebugConfig {
  urlOverrideEnabled: boolean;
  allowedOverrideKeys: string[];
}

export interface GameConfig {
  world: WorldConfig;
  terrain: TerrainConfig;
  physics: PhysicsConfig;
  wind: WindConfig;
  camera: CameraConfig;
  turn: TurnConfig;
  combat: CombatConfig;
  input: InputConfig;
  ui: UiConfig;
  render: RenderConfig;
  sim: SimConfig;
  debug: DebugConfig;
  tanks: TankTypeConfig[];
}

export const DEFAULT_CONFIG: GameConfig = {
  world: {
    width: 1080,
    height: 1920,
    outOfBoundsMargin: { left: 200, right: 200, top: 400, bottom: 200 },
  },
  terrain: {
    sampleStep: 2,
    baselineRatio: 0.6,
    minHeightRatio: 0.28,
    maxHeightRatio: 0.86,
    octaves: [
      { wavelength: 620, amplitude: 150 },
      { wavelength: 260, amplitude: 62 },
      { wavelength: 110, amplitude: 24 },
    ],
    spawnPlatform: { width: 260, edgeInset: 40, flatten: 1, flatRatio: 0.5 },
    surfaceSkinThickness: 12,
    maxClimbSlope: 1,
    maxDescendSlope: 2.2,
  },
  physics: {
    gravity: 900,
    projectileSubStep: 1 / 120,
    airDrag: 0,
  },
  wind: {
    minLevel: -8,
    maxLevel: 8,
    accelerationPerLevel: 12,
    rerollEachTurn: true,
    fixedLevel: null,
  },
  camera: {
    focusViewWidth: 460,
    focusViewHeight: 620,
    aimPadding: { horizontal: 90, top: 260, bottom: 120 },
    aimOpponentPadding: 24,
    aimZoomClampScale: 0.35,
    zoomClampScale: 0.9,
    followSmoothing: 8,
    overscrollAllowance: 120,
  },
  turn: {
    moveSpeed: 150,
    impactHoldSeconds: 0.8,
    explosionLifetime: 0.9,
    allowAimAnyTime: true,
  },
  combat: {
    directHitDamage: 25,
    explosionRadius: 90,
    splashMinDamage: 10,
    tankHitRadius: 26,
    selfHitGraceSeconds: 0.15,
    minTankSeparation: 44,
  },
  input: {
    tankTapRadiusPx: 60,
    maxDragPixels: 220,
    aimRadiusPaddingPx: 14,
    minAimRadiusPx: 96,
    cancelPowerThreshold: 0.08,
    trail: { maxSeconds: 2.5, sampleEverySteps: 4, maxPoints: 60 },
  },
  ui: {
    moveButtonSizePx: 64,
    safeAreaPadding: 12,
    damageFloatDuration: 0.9,
    resultDelaySeconds: 0.9,
  },
  render: {
    maxPixelRatio: 2,
    parallaxHills: [
      { parallax: 0.22, amplitude: 52, wavelength: 460, yOffset: -20 },
      { parallax: 0.45, amplitude: 34, wavelength: 280, yOffset: 26 },
    ],
    projectileRadius: 5,
    trailWidthPx: 2.5,
    previewWidthPx: 2,
    previewDashPx: 10,
    previewGapPx: 8,
    hpBarWidth: 58,
    hpBarHeight: 7,
    hpBarOffsetY: 56,
    activeRingRadius: 36,
  },
  sim: {
    fixedStep: 1 / 60,
    maxCatchUpSteps: 5,
    maxFrameSeconds: 0.25,
  },
  debug: {
    urlOverrideEnabled: true,
    allowedOverrideKeys: [
      'world.width',
      'world.height',
      'world.outOfBoundsMargin.left',
      'world.outOfBoundsMargin.right',
      'world.outOfBoundsMargin.top',
      'world.outOfBoundsMargin.bottom',
      'terrain.sampleStep',
      'terrain.baselineRatio',
      'terrain.minHeightRatio',
      'terrain.maxHeightRatio',
      'terrain.octaves',
      'terrain.spawnPlatform.width',
      'terrain.spawnPlatform.edgeInset',
      'terrain.spawnPlatform.flatten',
      'terrain.spawnPlatform.flatRatio',
      'terrain.surfaceSkinThickness',
      'terrain.maxClimbSlope',
      'terrain.maxDescendSlope',
      'physics.gravity',
      'physics.projectileSubStep',
      'physics.airDrag',
      'wind.minLevel',
      'wind.maxLevel',
      'wind.accelerationPerLevel',
      'wind.rerollEachTurn',
      'wind.fixedLevel',
      'camera.focusViewWidth',
      'camera.focusViewHeight',
      'camera.aimPadding.horizontal',
      'camera.aimPadding.top',
      'camera.aimPadding.bottom',
      'camera.aimOpponentPadding',
      'camera.aimZoomClampScale',
      'camera.zoomClampScale',
      'camera.followSmoothing',
      'camera.overscrollAllowance',
      'turn.moveSpeed',
      'turn.impactHoldSeconds',
      'turn.explosionLifetime',
      'turn.allowAimAnyTime',
      'combat.directHitDamage',
      'combat.explosionRadius',
      'combat.splashMinDamage',
      'combat.tankHitRadius',
      'combat.selfHitGraceSeconds',
      'combat.minTankSeparation',
      'input.tankTapRadiusPx',
      'input.maxDragPixels',
      'input.aimRadiusPaddingPx',
      'input.minAimRadiusPx',
      'input.cancelPowerThreshold',
      'input.trail.maxSeconds',
      'input.trail.sampleEverySteps',
      'input.trail.maxPoints',
      'ui.moveButtonSizePx',
      'ui.safeAreaPadding',
      'ui.damageFloatDuration',
      'ui.resultDelaySeconds',
      'render.maxPixelRatio',
      'render.projectileRadius',
      'render.trailWidthPx',
      'render.previewWidthPx',
      'render.previewDashPx',
      'render.previewGapPx',
      'render.hpBarWidth',
      'render.hpBarHeight',
      'render.hpBarOffsetY',
      'render.activeRingRadius',
    ],
  },
  tanks: [
    {
      id: 'scout',
      name: '游骑兵',
      blurb: '跑得远、打得活，但挨不了几下',
      hp: 80,
      movePoints: 280,
      minAngleDeg: -5,
      maxAngleDeg: 88,
      maxLaunchSpeed: 780,
      terrainDamageRadius: 40,
    },
    {
      id: 'standard',
      name: '标准型',
      blurb: '没有短板的均衡型',
      hp: 100,
      movePoints: 190,
      minAngleDeg: 10,
      maxAngleDeg: 82,
      maxLaunchSpeed: 900,
      terrainDamageRadius: 55,
    },
    {
      id: 'hammer',
      name: '重锤',
      blurb: '血厚力大，射界窄、跑不动',
      hp: 140,
      movePoints: 120,
      minAngleDeg: 20,
      maxAngleDeg: 75,
      maxLaunchSpeed: 1020,
      terrainDamageRadius: 80,
    },
  ],
};

export type TankTypeId = string;

export interface DerivedConfig {
  baseline: number;
  minHeight: number;
  maxHeight: number;
  terrainAmplitude: number;
  spawnX: Record<PlayerId, number>;
  killBounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export function derive(config: GameConfig): DerivedConfig {
  const { width, height, outOfBoundsMargin } = config.world;
  const platform = config.terrain.spawnPlatform;
  const spawnOffset = platform.edgeInset + platform.width * 0.3;
  const amplitude = config.terrain.octaves.reduce((acc, o) => acc + Math.abs(o.amplitude), 0);
  return {
    baseline: height * config.terrain.baselineRatio,
    minHeight: height * config.terrain.minHeightRatio,
    maxHeight: height * config.terrain.maxHeightRatio,
    terrainAmplitude: amplitude,
    spawnX: { left: spawnOffset, right: width - spawnOffset },
    killBounds: {
      minX: -outOfBoundsMargin.left,
      maxX: width + outOfBoundsMargin.right,
      minY: -outOfBoundsMargin.top,
      maxY: height + outOfBoundsMargin.bottom,
    },
  };
}

function createConfig(): GameConfig {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const enabled = DEFAULT_CONFIG.debug.urlOverrideEnabled;
  const { config, applied, rejected } = applyUrlOverrides(
    DEFAULT_CONFIG,
    DEFAULT_CONFIG.debug.allowedOverrideKeys,
    enabled ? search : '',
    { wind: 'wind.fixedLevel' },
  );
  if (typeof window !== 'undefined' && applied.length > 0) {
    console.info('[config] 已应用 URL 覆盖', applied);
  }
  if (typeof window !== 'undefined' && rejected.length > 0) {
    console.warn('[config] 以下参数无效已回退默认值', rejected);
  }
  return deepFreeze(config);
}

/** 全局唯一配置实例，所有子系统都从这里读数值。 */
export const CONFIG: GameConfig = createConfig();

export const DERIVED: DerivedConfig = derive(CONFIG);

/**
 * 瞄准力度圆的半径（CSS 像素）。
 * 圆是以坦克炮塔为圆心画在屏幕上的，半径必须让整圆落在视口内，
 * 否则手机竖屏上会有一部分角度/力度根本拖不到。
 * 视口短边不够时按短边收缩，但不小于 input.minAimRadiusPx。
 */
export function aimDragRadiusPx(cssWidth: number, cssHeight: number): number {
  const fit = Math.min(cssWidth, cssHeight) / 2 - CONFIG.input.aimRadiusPaddingPx;
  const upper = Math.max(CONFIG.input.minAimRadiusPx, CONFIG.input.maxDragPixels);
  return Math.min(upper, Math.max(CONFIG.input.minAimRadiusPx, fit));
}

/** 远端两端配置必须一致，握手时比对这个哈希。 */
export function gameplayConfigHash(): string {
  return stableHash({
    world: CONFIG.world,
    terrain: CONFIG.terrain,
    physics: CONFIG.physics,
    wind: CONFIG.wind,
    turn: CONFIG.turn,
    combat: CONFIG.combat,
    tanks: CONFIG.tanks,
  });
}
