import { createValueNoise1D, fbm, totalAmplitude } from '../core/noise.js';
import { clamp, lerp, smoothstep } from '../core/mathx.js';
import type { Rng } from '../core/rng.js';
import type { DerivedConfig, GameConfig } from '../config.js';
import { Terrain } from './Terrain.js';

/**
 * 两侧出生平台的压平权重：平台内侧一段完全压平（权重 1），
 * 再向外平滑衰减到 0，这样出生点必定是平的，又不会在地图中间留下台阶。
 */
function platformWeight(x: number, config: GameConfig): number {
  const { width, edgeInset, flatten, flatRatio } = config.terrain.spawnPlatform;
  const flatEnd = edgeInset + width * flatRatio;
  const inner = edgeInset + width;
  const left = 1 - smoothstep(flatEnd, inner, x);
  const right = 1 - smoothstep(flatEnd, inner, config.world.width - x);
  return Math.max(left, right) * flatten;
}

/**
 * 泰拉瑞亚式生成：先定一条把天地分开的地表中线，再用多倍频噪声起伏，
 * 最后把两侧出生平台拉回基线，保证开局不会卡在悬崖上。
 */
export function generateTerrain(config: GameConfig, derived: DerivedConfig, rng: Rng): Terrain {
  const { width, height } = config.world;
  const { sampleStep, octaves } = config.terrain;
  const count = Math.floor(width / sampleStep) + 1;
  const heights = new Float32Array(count);
  const noise = createValueNoise1D(rng.int(0, 0x7fffffff));
  const amplitude = totalAmplitude(octaves);

  for (let i = 0; i < count; i++) {
    const x = i * sampleStep;
    const rough = fbm(noise, x, octaves) * amplitude;
    const weight = platformWeight(x, config);
    const y = lerp(derived.baseline + rough, derived.baseline, clamp(weight, 0, 1));
    heights[i] = clamp(y, derived.minHeight, derived.maxHeight);
  }

  return new Terrain(heights, sampleStep, width, height);
}
