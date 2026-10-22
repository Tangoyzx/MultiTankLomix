/** mulberry32：小巧、可播种、跨端一致的伪随机数发生器。 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 闭区间整数。 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
  }
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
