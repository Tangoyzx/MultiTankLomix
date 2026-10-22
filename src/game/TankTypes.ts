import { CONFIG } from '../config.js';
import type { TankTypeConfig } from '../config.js';

export const DEFAULT_TANK_ID = 'standard';

export function allTankTypes(): readonly TankTypeConfig[] {
  return CONFIG.tanks;
}

export function findTankType(id: string): TankTypeConfig {
  return CONFIG.tanks.find((t) => t.id === id) ?? CONFIG.tanks[0];
}

export function defaultTankType(): TankTypeConfig {
  return findTankType(DEFAULT_TANK_ID);
}
