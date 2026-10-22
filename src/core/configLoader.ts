function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseValue(raw: string, current: unknown): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (typeof current === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return undefined;
  }
  if (typeof current === 'number' || current === null) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return trimmed;
}

function getPath(target: unknown, path: string[]): unknown {
  let cursor: unknown = target;
  for (const key of path) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextValue = cursor[key];
    if (!isPlainObject(nextValue)) return;
    cursor = nextValue as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

export interface OverrideReport {
  key: string;
  from: unknown;
  to: unknown;
}

/**
 * 把 URL 查询参数（?wind=5&world.width=1400）按点路径写回配置副本。
 * 只有白名单内的键生效，解析失败回退默认值并回报，方便发现手抖打错的参数。
 */
export function applyUrlOverrides<T extends object>(
  source: T,
  allowedKeys: readonly string[],
  search: string,
  aliases: Record<string, string> = {},
): { config: T; applied: OverrideReport[]; rejected: string[] } {
  const config = structuredClone(source) as Record<string, unknown>;
  const applied: OverrideReport[] = [];
  const rejected: string[] = [];
  const params = new URLSearchParams(search);

  for (const [key, raw] of params.entries()) {
    const targetKey = aliases[key] ?? key;
    if (!allowedKeys.includes(targetKey)) continue;
    const path = targetKey.split('.');
    const current = getPath(config, path);
    if (current === undefined) {
      rejected.push(key);
      continue;
    }
    const parsed = parseValue(raw, current);
    if (parsed === undefined) {
      rejected.push(key);
      continue;
    }
    setPath(config, path, parsed);
    applied.push({ key, from: current, to: parsed });
  }

  return { config: config as T, applied, rejected };
}

/** 递归冻结，把误改配置变成开发期就能发现的硬错误。 */
export function deepFreeze<T>(value: T): T {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

/** 远端两端配置必须一致，用内容哈希做握手校验。 */
export function stableHash(value: unknown): string {
  const json = JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
