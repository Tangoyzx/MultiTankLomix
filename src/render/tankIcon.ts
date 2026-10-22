import { degToRad } from '../core/mathx.js';
import type { TankTypeConfig } from '../config.js';
import { PALETTE } from './palette.js';

/**
 * 选坦界面的缩略图：用与战场上同一套几何画一个小坦克，
 * 炮管角度取该型号射界中值，直观反映“射界窄/宽”。
 */
export function drawTankIcon(
  canvas: HTMLCanvasElement,
  type: TankTypeConfig,
  body: string,
  dark: string,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 96;
  const h = canvas.clientHeight || 64;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = Math.min(w / 120, h / 80);
  const cx = w / 2;
  const groundY = h * 0.78;

  ctx.save();
  ctx.translate(cx, groundY);
  ctx.scale(scale, scale);

  // 地面
  ctx.fillStyle = PALETTE.soilTop;
  ctx.fillRect(-58, 0, 116, 6);

  // 履带
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.roundRect(-26, -12, 52, 12, 6);
  ctx.fill();

  // 车体
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(-22, -30, 44, 18, 4);
  ctx.fill();

  // 炮塔
  ctx.fillStyle = PALETTE.tankMetal;
  ctx.beginPath();
  ctx.arc(0, -30, 11, 0, Math.PI * 2);
  ctx.fill();

  // 炮管
  const mid = (type.minAngleDeg + type.maxAngleDeg) / 2;
  ctx.save();
  ctx.translate(0, -30);
  ctx.rotate(-degToRad(mid));
  ctx.fillStyle = PALETTE.barrel;
  ctx.fillRect(0, -3, 26, 6);
  ctx.restore();

  ctx.restore();
}
