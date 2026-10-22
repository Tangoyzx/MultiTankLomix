import { CONFIG } from '../config.js';
import { approach, clamp } from '../core/mathx.js';
import type { Vec2 } from '../core/types.js';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 世界坐标 → 屏幕坐标：zoom 表示“每世界单位多少 CSS 像素”。
 * 三种镜头意图：聚焦当前坦克、框住双方、跟随子弹。
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  cssWidth = 1;
  cssHeight = 1;

  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;

  setViewport(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.targetZoom = this.clampZoom(this.targetZoom);
    this.zoom = this.clampZoom(this.zoom);
  }

  get focusZoom(): number {
    return Math.min(
      this.cssWidth / CONFIG.camera.focusViewWidth,
      this.cssHeight / CONFIG.camera.focusViewHeight,
    );
  }

  get worldFitZoom(): number {
    return Math.min(this.cssWidth / CONFIG.world.width, this.cssHeight / CONFIG.world.height);
  }

  get minZoom(): number {
    return this.worldFitZoom * CONFIG.camera.zoomClampScale;
  }

  get maxZoom(): number {
    return Math.max(this.focusZoom, this.minZoom);
  }

  clampZoom(zoom: number): number {
    return clamp(zoom, this.minZoom, this.maxZoom);
  }

  private clampCenter(x: number, y: number, allowance = CONFIG.camera.overscrollAllowance): Vec2 {
    const halfW = this.cssWidth / this.zoom / 2;
    const halfH = this.cssHeight / this.zoom / 2;
    const minX = -allowance;
    const maxX = CONFIG.world.width + allowance;
    const minY = -allowance;
    const maxY = CONFIG.world.height + allowance;
    const cx = halfW * 2 >= maxX - minX ? (minX + maxX) / 2 : clamp(x, minX + halfW, maxX - halfW);
    const cy = halfH * 2 >= maxY - minY ? (minY + maxY) / 2 : clamp(y, minY + halfH, maxY - halfH);
    return { x: cx, y: cy };
  }

  focusOn(x: number, y: number): void {
    this.targetZoom = this.clampZoom(this.focusZoom);
    const center = this.clampCenter(x, y - this.cssHeight / this.targetZoom * 0.1);
    this.targetX = center.x;
    this.targetY = center.y;
  }

  /** 框住双方：用于瞄准阶段“同时看到两个坦克”。 */
  frameBox(box: Box, padding = CONFIG.camera.aimPadding): void {
    const width = Math.max(1, box.maxX - box.minX + padding.horizontal * 2);
    const height = Math.max(1, box.maxY - box.minY + padding.top + padding.bottom);
    const zoom = this.clampZoom(Math.min(this.cssWidth / width, this.cssHeight / height));
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2 + (padding.bottom - padding.top) / 2;
    this.targetZoom = zoom;
    const center = this.clampCenter(cx, cy);
    this.targetX = center.x;
    this.targetY = center.y;
  }

  lookAt(x: number, y: number): void {
    const center = this.clampCenter(x, y);
    this.targetX = center.x;
    this.targetY = center.y;
  }

  /**
   * 瞄准阶段取景：同时满足三件事
   * 1) 以炮塔为圆心的力度圆（radiusPx）完整落在屏幕内；
   * 2) 对手坦克仍在画面内（离边缘至少 aimOpponentPadding）；
   * 3) 尽量不放得太远，优先沿用聚焦缩放。
   * 因此这里允许镜头中心越过世界边界，否则贴边出生的坦克没法居中。
   */
  frameAim(pivot: Vec2, opponent: Vec2, radiusPx: number): void {
    const clearance = radiusPx + CONFIG.input.aimRadiusPaddingPx;
    const oppPad = CONFIG.camera.aimOpponentPadding;
    const dx = Math.max(1, Math.abs(opponent.x - pivot.x));
    const dy = Math.max(1, Math.abs(opponent.y - pivot.y));
    const fitX = (this.cssWidth - clearance - oppPad) / dx;
    const fitY = (this.cssHeight - clearance - oppPad) / dy;
    const floor = this.worldFitZoom * CONFIG.camera.aimZoomClampScale;
    const zoom = Math.max(floor, Math.min(this.focusZoom, fitX, fitY));

    const centerX = this.aimAxisCenter(pivot.x, opponent.x, zoom, this.cssWidth, clearance, oppPad);
    const centerY = this.aimAxisCenter(pivot.y, opponent.y, zoom, this.cssHeight, clearance, oppPad);
    // 允许镜头中心越界：贴着地图边出生的坦克也要能居中，否则力度圆会被屏幕切掉。
    // 过渡期 clampCenter 用的是当前 zoom，这里按更小的 zoom 给足余量。
    const zoomForAllowance = Math.min(this.zoom, zoom);
    const allowance =
      CONFIG.camera.overscrollAllowance +
      (Math.max(this.cssWidth, this.cssHeight) / 2 + clearance) / zoomForAllowance;

    this.targetZoom = zoom;
    const center = this.clampCenter(centerX, centerY, allowance);
    this.targetX = center.x;
    this.targetY = center.y;
  }

  /**
   * 单轴上求镜头中心：圆心（自己）左右各留 clearance、对手左右各留 oppPad，
   * 两个可行区间求交集，取靠近双方中点的解。
   */
  private aimAxisCenter(
    self: number,
    opponent: number,
    zoom: number,
    viewport: number,
    clearance: number,
    oppPad: number,
  ): number {
    const selfSpan = Math.max(0, viewport / 2 - clearance) / zoom;
    const oppSpan = Math.max(0, viewport / 2 - oppPad) / zoom;
    const lo = Math.max(self - selfSpan, opponent - oppSpan);
    const hi = Math.min(self + selfSpan, opponent + oppSpan);
    const preferred = (self + opponent) / 2;
    // 缩放刚好卡在临界值时两个区间只是相切，取相切点而不是双方中点。
    if (lo > hi) return (lo + hi) / 2;
    return clamp(preferred, lo, hi);
  }

  snap(): void {
    this.x = this.targetX;
    this.y = this.targetY;
    this.zoom = this.targetZoom;
  }

  update(dt: number): void {
    const rate = CONFIG.camera.followSmoothing;
    this.x = approach(this.x, this.targetX, rate, dt);
    this.y = approach(this.y, this.targetY, rate, dt);
    this.zoom = approach(this.zoom, this.targetZoom, rate, dt);
  }

  worldToScreen(wx: number, wy: number): Vec2 {
    return {
      x: this.cssWidth / 2 + (wx - this.x) * this.zoom,
      y: this.cssHeight / 2 + (wy - this.y) * this.zoom,
    };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: this.x + (sx - this.cssWidth / 2) / this.zoom,
      y: this.y + (sy - this.cssHeight / 2) / this.zoom,
    };
  }

  visibleBox(): Box {
    const halfW = this.cssWidth / this.zoom / 2;
    const halfH = this.cssHeight / this.zoom / 2;
    return { minX: this.x - halfW, minY: this.y - halfH, maxX: this.x + halfW, maxY: this.y + halfH };
  }

  applyTo(ctx: CanvasRenderingContext2D, dpr: number): void {
    ctx.setTransform(
      dpr * this.zoom,
      0,
      0,
      dpr * this.zoom,
      dpr * (this.cssWidth / 2 - this.x * this.zoom),
      dpr * (this.cssHeight / 2 - this.y * this.zoom),
    );
  }
}
