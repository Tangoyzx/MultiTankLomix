import { CONFIG } from '../config.js';
import type { Vec2 } from '../core/types.js';
import type { Camera } from '../render/Camera.js';

export interface PointerInputHost {
  canControl(): boolean;
  /** 当前操作方坦克的屏幕坐标，用于判定“按在坦克上”。 */
  activeTankScreen(): Vec2 | null;
  /** 当前操作方坦克瞄准基准点（炮塔中心）的屏幕坐标，拖拽以它为原点。 */
  activeAimPivotScreen(): Vec2 | null;
  activeTankWorld(): Vec2 | null;
  /** 返回 false 表示当前阶段不允许进入瞄准。 */
  onAimStart(): boolean;
  onAimMove(world: Vec2, dragPixels: number): void;
  onAimEnd(): void;
}

/**
 * 统一处理鼠标与触摸：pointer 事件 + setPointerCapture。
 * 只有按在坦克上才会进入瞄准，拖拽距离（CSS 像素）决定力度。
 * 拖拽的中心始终是坦克当前的屏幕位置：进入瞄准后镜头会拉远，坦克在屏幕上会移动，
 * 若沿用按下瞬间的快照，力度与弹弓提示线就会和轨迹线起点（坦克）脱节。
 */
export class PointerInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Camera;
  private readonly host: PointerInputHost;
  private activePointer: number | null = null;
  private pointer: Vec2 | null = null;
  /** 是否真的拖动过：只是点一下坦克不该走火。 */
  private moved = false;

  private readonly onDown = (event: PointerEvent): void => {
    if (this.activePointer !== null) return;
    if (!this.host.canControl()) return;
    const point = this.toScreen(event);
    const tank = this.host.activeTankScreen();
    if (!tank) return;
    if (Math.hypot(point.x - tank.x, point.y - tank.y) > CONFIG.input.tankTapRadiusPx) return;
    if (!this.host.onAimStart()) return;

    this.activePointer = event.pointerId;
    this.pointer = point;
    this.moved = false;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* 某些浏览器不支持捕获，退化为普通事件即可 */
    }
    // 按下瞬间还没有拖拽，力度为 0；之后每次移动都以坦克瞄准基准点重新计算。
    this.host.onAimMove(this.toWorld(point), 0);
    event.preventDefault();
  };

  private readonly onMove = (event: PointerEvent): void => {
    const point = this.toScreen(event);
    this.pointer = point;
    if (this.activePointer !== event.pointerId) return;
    this.moved = true;
    this.host.onAimMove(this.toWorld(point), this.dragPixelsFrom(point));
    event.preventDefault();
  };

  private readonly onUp = (event: PointerEvent): void => {
    if (this.activePointer !== event.pointerId) return;
    const point = this.resolvePoint(event);
    this.activePointer = null;
    this.pointer = null;
    // 只是点了一下坦克（全程没有移动）算取消，不走火；
    // 真的拖动过就按松开点相对坦克的实际距离结算，力度阈值交给 cancelPowerThreshold 判断。
    if (!this.moved) this.host.onAimMove(this.toWorld(point), 0);
    this.moved = false;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* 已经释放过 */
    }
    this.host.onAimEnd();
    event.preventDefault();
  };

  private readonly onCancel = (event: PointerEvent): void => {
    if (this.activePointer !== event.pointerId) return;
    this.activePointer = null;
    this.pointer = null;
    this.host.onAimEnd();
  };

  constructor(canvas: HTMLCanvasElement, camera: Camera, host: PointerInputHost) {
    this.canvas = canvas;
    this.camera = camera;
    this.host = host;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('lostpointercapture', this.onCancel);
  }

  get dragging(): boolean {
    return this.activePointer !== null;
  }

  /** 弹弓提示线：从坦克瞄准基准点连到指针，与轨迹线起点保持一致。 */
  get aimHint(): { origin: Vec2; pointer: Vec2 } | null {
    if (!this.dragging || !this.pointer) return null;
    const origin = this.aimOrigin();
    if (!origin) return null;
    return { origin, pointer: this.pointer };
  }

  /** 拖拽向量以坦克当前的瞄准基准点为原点，而不是按下瞬间的快照。 */
  private dragPixelsFrom(point: Vec2): number {
    const origin = this.aimOrigin();
    if (!origin) return 0;
    return Math.hypot(point.x - origin.x, point.y - origin.y);
  }

  private aimOrigin(): Vec2 | null {
    return this.host.activeAimPivotScreen() ?? this.host.activeTankScreen();
  }

  private toScreen(event: PointerEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** pointerup / lostpointercapture 偶尔不带坐标，退回最后一次已知位置。 */
  private resolvePoint(event: PointerEvent): Vec2 {
    const point = this.toScreen(event);
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
    return this.pointer ?? { x: 0, y: 0 };
  }

  private toWorld(point: Vec2): Vec2 {
    return this.camera.screenToWorld(point.x, point.y);
  }

  dispose(): void {
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onCancel);
    canvas.removeEventListener('lostpointercapture', this.onCancel);
  }
}
