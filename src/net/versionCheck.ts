/**
 * 版本自检：玩家本地加载的是哪一次构建，服务端现在部署的是哪一次构建。
 *
 * 资源文件名不带内容哈希，靠「入口 no-store + js/css 带 ?v=<构建指纹>」拿到最新内容，
 * 这里再兜一层：发现服务端指纹变了就提示玩家刷新，避免有人挂着一整天的旧页面。
 * 指纹由构建产物内容算出，代码没变就不会误报。
 */
export interface VersionInfo {
  version: string;
  build: string;
  buildTime?: string | null;
  gitCommit?: string | null;
}

function metaContent(name: string): string | null {
  const node = typeof document === 'undefined' ? null : document.querySelector(`meta[name="${name}"]`);
  const value = node?.getAttribute('content') ?? null;
  return value && value.length > 0 ? value : null;
}

/** 本地构建信息读页面里的 meta，由 tools/build.mjs 注入。 */
export function readLocalVersion(): VersionInfo {
  return {
    version: metaContent('app-version') ?? 'dev',
    build: metaContent('app-build') ?? 'dev',
  };
}

export function formatVersion(info: Partial<VersionInfo> | null | undefined): string {
  if (!info) return '';
  return [info.version, info.gitCommit ?? info.build].filter(Boolean).join(' · ');
}

/**
 * 是否落后于服务端：优先比构建指纹（内容变了才算新版本），
 * 拿不到指纹时退回比版本号字符串。
 */
export function isOutdated(local: VersionInfo, server: Partial<VersionInfo> | null): boolean {
  if (!server) return false;
  // 开发模式（vite）页面里没有构建指纹，拿不到就别拿它误判
  if (!local.build || local.build === 'dev') return false;
  if (local.build && server.build) return local.build !== server.build;
  return Boolean(local.version && server.version && local.version !== server.version);
}

/** 向服务端要当前版本清单，永远绕过缓存；拿不到就返回 null（不影响游戏）。 */
export async function fetchServerVersion(): Promise<VersionInfo | null> {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<VersionInfo>;
    if (!payload || typeof payload !== 'object') return null;
    return {
      version: typeof payload.version === 'string' ? payload.version : '',
      build: typeof payload.build === 'string' ? payload.build : '',
      buildTime: payload.buildTime ?? null,
      gitCommit: payload.gitCommit ?? null,
    };
  } catch {
    return null;
  }
}
