import { clamp } from '../core/mathx.js';
import type { Vec2 } from '../core/types.js';

/**
 * 离散高度场地形：y 向下为正，heightAt(x) 返回地表在世界中的 y。
 * 地表之上是天空，之下是土层。
 */
export class Terrain {
  readonly heights: Float32Array;
  readonly sampleStep: number;
  readonly width: number;
  readonly height: number;

  constructor(heights: Float32Array, sampleStep: number, width: number, height: number) {
    this.heights = heights;
    this.sampleStep = sampleStep;
    this.width = width;
    this.height = height;
  }

  get sampleCount(): number {
    return this.heights.length;
  }

  heightAt(x: number): number {
    const cx = clamp(x, 0, this.width);
    const t = cx / this.sampleStep;
    const i = Math.floor(t);
    const f = t - i;
    const last = this.heights.length - 1;
    const a = this.heights[Math.min(i, last)];
    const b = this.heights[Math.min(i + 1, last)];
    return a + (b - a) * f;
  }

  /** dh/dx，正值表示向右地形变低。 */
  slopeAt(x: number): number {
    const d = this.sampleStep;
    return (this.heightAt(x + d) - this.heightAt(x - d)) / (2 * d);
  }

  /** 地表朝上法线。 */
  normalAt(x: number): Vec2 {
    const slope = this.slopeAt(x);
    const len = Math.hypot(slope, 1);
    return { x: slope / len, y: -1 / len };
  }

  /** 车身贴地旋转角：让坦克的“上”与法线一致，而不是恒等于屏幕上方。 */
  rotationAt(x: number): number {
    return Math.atan(this.slopeAt(x));
  }

  isUnderground(x: number, y: number): boolean {
    return y >= this.heightAt(x);
  }

  /** 线段与地表求交，命中点在段内二分细化。 */
  refineSurfaceHit(from: Vec2, to: Vec2): Vec2 {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const x = from.x + (to.x - from.x) * mid;
      const y = from.y + (to.y - from.y) * mid;
      if (y >= this.heightAt(x)) hi = mid;
      else lo = mid;
    }
    const t = (lo + hi) / 2;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
}
