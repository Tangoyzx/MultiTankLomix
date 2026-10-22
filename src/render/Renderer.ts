import { aimDragRadiusPx, CONFIG, DERIVED } from '../config.js';
import { degToRad } from '../core/mathx.js';
import { PLAYER_IDS, sideLabel } from '../core/types.js';
import type { PlayerId, Vec2 } from '../core/types.js';
import { TANK_PIVOT_Y, TANK_VISUAL } from '../entities/Tank.js';
import type { Tank } from '../entities/Tank.js';
import type { PreviewPath } from '../game/Ballistics.js';
import type { BattleState } from '../game/BattleState.js';
import type { Terrain } from '../world/Terrain.js';
import { PALETTE, tankColors } from './palette.js';
import type { Camera } from './Camera.js';

export interface AimScreenHint {
  origin: Vec2;
  pointer: Vec2;
}

export interface RenderView {
  activePlayerId: PlayerId;
  preview: PreviewPath | null;
  aimScreen: AimScreenHint | null;
  /** 远端模式下对手回合，用于画一个锁定提示。 */
  locked: boolean;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 纯程序化绘制：天空渐变 → 视差远山 → 地形 → 坦克 → 弹道与特效 → 屏幕空间 HUD 标记。
 * 所有几何都取自 CONFIG / DERIVED，不额外引入美术资源。
 */
export class Renderer {
  dpr = 1;
  cssWidth = 1;
  cssHeight = 1;
  /** 力度圆半径：随视口收缩，保证整圆可见。 */
  aimRadiusPx = CONFIG.input.maxDragPixels;
  private time = 0;
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;

  constructor(ctx: CanvasRenderingContext2D, camera: Camera) {
    this.ctx = ctx;
    this.camera = camera;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = dpr;
    this.aimRadiusPx = aimDragRadiusPx(this.cssWidth, this.cssHeight);
    this.camera.setViewport(this.cssWidth, this.cssHeight);
  }

  render(state: BattleState, view: RenderView, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSky();
    this.drawHills();

    this.camera.applyTo(ctx, this.dpr);
    this.drawTerrain(state.world.terrain);
    this.drawActiveRing(state, view);
    for (const id of PLAYER_IDS) {
      const tank = state.tanks[id];
      if (tank.alive) this.drawTank(tank, id === view.activePlayerId);
    }
    this.drawProjectile(state);
    this.drawPreview(view.preview);
    this.drawExplosions(state);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBadges(state);
    this.drawAimHint(view.aimScreen);
    this.drawFloaters(state);
    ctx.globalAlpha = 1;
  }

  private drawSky(): void {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.outOfWorld;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    const worldTop = this.camera.worldToScreen(0, 0).y;
    const worldBottom = this.camera.worldToScreen(0, CONFIG.world.height).y;
    const gradient = ctx.createLinearGradient(0, worldTop, 0, Math.max(worldTop + 1, worldBottom));
    gradient.addColorStop(0, PALETTE.skyTop);
    gradient.addColorStop(0.55, PALETTE.skyMiddle);
    gradient.addColorStop(1, PALETTE.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** 视差远山：只跟镜头做部分位移，营造纵深。 */
  private drawHills(): void {
    const ctx = this.ctx;
    const horizon = this.camera.worldToScreen(0, DERIVED.baseline).y;
    const layers = CONFIG.render.parallaxHills;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const shift = this.camera.x * layer.parallax * this.camera.zoom;
      const amp = layer.amplitude * this.camera.zoom;
      const wave = layer.wavelength * this.camera.zoom;
      const baseY = horizon + layer.yOffset * this.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-1, this.cssHeight + 1);
      for (let sx = -1; sx <= this.cssWidth + 1; sx += 16) {
        const t = (sx + shift) / wave;
        const y =
          baseY +
          Math.sin(t * Math.PI * 2) * amp +
          Math.sin(t * Math.PI * 4 + li * 1.7) * amp * 0.35;
        ctx.lineTo(sx, y);
      }
      ctx.lineTo(this.cssWidth + 1, this.cssHeight + 1);
      ctx.closePath();
      ctx.fillStyle = li === 0 ? PALETTE.hillFar : PALETTE.hillNear;
      ctx.fill();
    }
  }

  private surfacePath(terrain: Terrain, fromX: number, toX: number): void {
    const ctx = this.ctx;
    const step = CONFIG.terrain.sampleStep;
    ctx.beginPath();
    ctx.moveTo(fromX, terrain.heightAt(fromX));
    for (let x = fromX + step; x <= toX; x += step) ctx.lineTo(x, terrain.heightAt(x));
    ctx.lineTo(toX, terrain.heightAt(toX));
  }

  private drawTerrain(terrain: Terrain): void {
    const ctx = this.ctx;
    const box = this.camera.visibleBox();
    const step = CONFIG.terrain.sampleStep;
    // 瞄准时镜头可能拉到比整张地图更远，地表要一直铺到可见范围外，否则会露出地图外的空当。
    const startX = Math.floor(box.minX / step) * step - step;
    const endX = Math.ceil(box.maxX / step) * step + step;
    const bottom = Math.max(
      CONFIG.world.height + CONFIG.camera.overscrollAllowance + CONFIG.render.hpBarOffsetY,
      box.maxY + CONFIG.camera.overscrollAllowance,
    );

    this.surfacePath(terrain, startX, endX);
    ctx.lineTo(endX, bottom);
    ctx.lineTo(startX, bottom);
    ctx.closePath();
    const soil = ctx.createLinearGradient(0, DERIVED.minHeight, 0, CONFIG.world.height);
    soil.addColorStop(0, PALETTE.soilTop);
    soil.addColorStop(0.45, PALETTE.soilMid);
    soil.addColorStop(1, PALETTE.soilDeep);
    ctx.fillStyle = soil;
    ctx.fill();

    this.surfacePath(terrain, startX, endX);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.skin;
    ctx.lineWidth = CONFIG.terrain.surfaceSkinThickness;
    ctx.stroke();
    ctx.strokeStyle = PALETTE.skinEdge;
    ctx.lineWidth = CONFIG.terrain.surfaceSkinThickness * 0.3;
    ctx.stroke();
  }

  private drawActiveRing(state: BattleState, view: RenderView): void {
    const ctx = this.ctx;
    const tank = state.tanks[view.activePlayerId];
    if (!tank.alive || view.locked) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.35 * pulse;
    ctx.strokeStyle = PALETTE.activeRing;
    ctx.lineWidth = 3 / this.camera.zoom;
    ctx.beginPath();
    ctx.ellipse(tank.x, tank.y, CONFIG.render.activeRingRadius, CONFIG.render.activeRingRadius * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTank(tank: Tank, active: boolean): void {
    const ctx = this.ctx;
    const colors = tankColors(tank.id);
    const { bodyWidth, bodyHeight, trackRadius, barrelLength, barrelWidth } = TANK_VISUAL;
    const trackTop = -trackRadius * 2;

    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.rotate(tank.rotation);

    // 履带
    roundRectPath(ctx, -bodyWidth / 2, trackTop, bodyWidth, trackRadius * 2, trackRadius);
    ctx.fillStyle = colors.dark;
    ctx.fill();
    ctx.strokeStyle = PALETTE.tankMetalDark;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 车体
    roundRectPath(ctx, -bodyWidth / 2 + 2, TANK_PIVOT_Y, bodyWidth - 4, bodyHeight, 4);
    ctx.fillStyle = colors.body;
    ctx.fill();
    ctx.strokeStyle = colors.dark;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 朝向标记：车头一侧的挡板
    ctx.fillStyle = PALETTE.tankMetal;
    ctx.fillRect(
      tank.facing > 0 ? bodyWidth / 2 - 8 : -bodyWidth / 2 + 3,
      TANK_PIVOT_Y + 3,
      5,
      bodyHeight - 6,
    );

    // 炮塔
    ctx.beginPath();
    ctx.arc(0, TANK_PIVOT_Y, bodyHeight * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.tankMetal;
    ctx.fill();
    ctx.strokeStyle = PALETTE.tankMetalDark;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 炮管：与 muzzle() 同源，抬升角即发射角
    const angle = degToRad(tank.barrelAngleDeg);
    ctx.save();
    ctx.translate(0, TANK_PIVOT_Y);
    ctx.scale(tank.barrelDirSign, 1);
    ctx.rotate(-angle);
    ctx.fillStyle = PALETTE.barrel;
    ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
    ctx.strokeStyle = PALETTE.tankMetalDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
    ctx.restore();

    if (tank.hitFlash > 0) {
      ctx.globalAlpha = Math.min(1, tank.hitFlash * 2);
      ctx.fillStyle = '#ff6a4d';
      roundRectPath(ctx, -bodyWidth / 2, TANK_PIVOT_Y, bodyWidth, bodyHeight + trackRadius * 2, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (active) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = PALETTE.activeRing;
      ctx.lineWidth = 2;
      roundRectPath(ctx, -bodyWidth / 2 - 3, TANK_PIVOT_Y - 3, bodyWidth + 6, bodyHeight + trackRadius * 2 + 6, 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private drawProjectile(state: BattleState): void {
    const projectile = state.projectile;
    if (!projectile) return;
    const ctx = this.ctx;
    const inv = 1 / this.camera.zoom;

    if (projectile.trail.length > 1) {
      ctx.strokeStyle = PALETTE.trail;
      ctx.lineWidth = CONFIG.render.trailWidthPx * inv;
      ctx.beginPath();
      ctx.moveTo(projectile.trail[0].x, projectile.trail[0].y);
      for (let i = 1; i < projectile.trail.length; i++) {
        ctx.lineTo(projectile.trail[i].x, projectile.trail[i].y);
      }
      ctx.stroke();
    }

    const p = projectile.position;
    ctx.beginPath();
    ctx.arc(p.x, p.y, CONFIG.render.projectileRadius, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.text;
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(p.x, p.y, CONFIG.render.projectileRadius * 2.4, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.preview;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawPreview(preview: PreviewPath | null): void {
    if (!preview || preview.points.length < 2) return;
    const ctx = this.ctx;
    const inv = 1 / this.camera.zoom;
    const end = preview.points[preview.points.length - 1];
    ctx.save();
    ctx.setLineDash([CONFIG.render.previewDashPx * inv, CONFIG.render.previewGapPx * inv]);
    ctx.strokeStyle = PALETTE.preview;
    ctx.lineWidth = CONFIG.render.previewWidthPx * inv;
    ctx.beginPath();
    ctx.moveTo(preview.points[0].x, preview.points[0].y);
    for (let i = 1; i < preview.points.length; i++) ctx.lineTo(preview.points[i].x, preview.points[i].y);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(end.x, end.y, CONFIG.render.projectileRadius * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = preview.hit?.kind === 'tank' ? PALETTE.previewHit : PALETTE.preview;
    ctx.fill();
  }

  private drawExplosions(state: BattleState): void {
    const ctx = this.ctx;
    for (const explosion of state.explosions) {
      const p = explosion.progress;
      const ease = 1 - (1 - p) * (1 - p);
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = PALETTE.previewHit;
      ctx.lineWidth = 4 / this.camera.zoom;
      ctx.beginPath();
      ctx.arc(explosion.x, explosion.y, explosion.radius * (0.25 + 0.75 * ease), 0, Math.PI * 2);
      ctx.stroke();

      for (const particle of explosion.particles) {
        const life = Math.max(0, particle.life / particle.maxLife);
        ctx.globalAlpha = life;
        ctx.fillStyle = life > 0.6 ? PALETTE.preview : PALETTE.previewHit;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius * (0.4 + life * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawBadges(state: BattleState): void {
    const ctx = this.ctx;
    const { hpBarWidth, hpBarHeight, hpBarOffsetY } = CONFIG.render;
    for (const id of PLAYER_IDS) {
      const tank = state.tanks[id];
      if (!tank.alive) continue;
      const p = this.camera.worldToScreen(tank.x, tank.y);
      const offset = Math.max(24, hpBarOffsetY * this.camera.zoom);
      const x = p.x - hpBarWidth / 2;
      const y = p.y - offset;
      ctx.fillStyle = PALETTE.hpBack;
      ctx.fillRect(x - 1, y - 1, hpBarWidth + 2, hpBarHeight + 2);
      const ratio = Math.max(0, tank.hp / tank.maxHp);
      ctx.fillStyle = ratio > 0.35 ? PALETTE.hpFill : PALETTE.hpFillLow;
      ctx.fillRect(x, y, hpBarWidth * ratio, hpBarHeight);

      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = PALETTE.text;
      ctx.fillText(`${sideLabel(id)} ${Math.ceil(tank.hp)}`, x, y - 4);
    }
  }

  /** 瞄准时的弹弓提示：拖拽方向与力度环。 */
  private drawAimHint(hint: AimScreenHint | null): void {
    if (!hint) return;
    const ctx = this.ctx;
    const dx = hint.pointer.x - hint.origin.x;
    const dy = hint.pointer.y - hint.origin.y;
    const drag = Math.hypot(dx, dy);
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hint.origin.x, hint.origin.y);
    ctx.lineTo(hint.pointer.x, hint.pointer.y);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hint.origin.x, hint.origin.y, this.aimRadiusPx, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = PALETTE.preview;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(hint.origin.x, hint.origin.y, Math.max(1, drag), 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawFloaters(state: BattleState): void {
    const ctx = this.ctx;
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const floater of state.floaters) {
      const p = this.camera.worldToScreen(floater.x, floater.y);
      ctx.globalAlpha = Math.max(0, Math.min(1, floater.life / floater.maxLife));
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }
}
