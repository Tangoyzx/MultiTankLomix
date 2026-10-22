export type Noise1D = (x: number) => number;

export interface NoiseOctave {
  wavelength: number;
  amplitude: number;
}

function hash1(seed: number, i: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(seed, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** 1D value noise，输出 [-1, 1]。 */
export function createValueNoise1D(seed: number): Noise1D {
  return (x: number): number => {
    const i = Math.floor(x);
    const f = x - i;
    const a = hash1(seed, i);
    const b = hash1(seed, i + 1);
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

/** 多倍频叠加，按总振幅归一化到 [-1, 1]。 */
export function fbm(noise: Noise1D, x: number, octaves: readonly NoiseOctave[]): number {
  let sum = 0;
  let total = 0;
  for (const octave of octaves) {
    if (octave.amplitude === 0 || octave.wavelength === 0) continue;
    sum += noise(x / octave.wavelength) * octave.amplitude;
    total += octave.amplitude;
  }
  return total === 0 ? 0 : sum / total;
}

export function totalAmplitude(octaves: readonly NoiseOctave[]): number {
  return octaves.reduce((acc, o) => acc + Math.abs(o.amplitude), 0);
}
