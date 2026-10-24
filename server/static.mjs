import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { readVersion } from './version.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 入口与版本清单必须每次回源，否则玩家会拿到旧页面。 */
const NO_STORE_PATHS = new Set(['/index.html', '/', '/version.json']);

export function createStaticHandler(root, { version: fallbackVersion = '0.0.0' } = {}) {
  const siteRoot = resolve(root);

  async function readVersionPayload() {
    return readVersion(siteRoot, fallbackVersion);
  }

  function resolveFile(pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    return join(siteRoot, rel);
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

      if (pathname === '/version.json') {
        const version = await readVersionPayload();
        res.writeHead(200, {
          'Content-Type': MIME['.json'],
          'Cache-Control': 'no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(JSON.stringify(version));
        return;
      }

      let filePath = resolveFile(pathname);
      const info = await stat(filePath).catch(() => null);
      if (!info || info.isDirectory()) filePath = join(siteRoot, 'index.html');
      const body = await readFile(filePath);
      const type = MIME[extname(filePath)] ?? 'application/octet-stream';
      const etag = `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 27)}"`;
      const noStore = NO_STORE_PATHS.has(pathname) || type.startsWith('text/html');

      if (!noStore && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache, must-revalidate' });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': type,
        ETag: etag,
        // 入口永不缓存；其余资源可以存，但每次使用前必须回源校验（no-cache 的效果）。
        'Cache-Control': noStore
          ? 'no-store, no-cache, must-revalidate'
          : 'no-cache, must-revalidate',
        ...(noStore ? { Pragma: 'no-cache', Expires: '0' } : {}),
      });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`404 ${error instanceof Error ? error.message : ''}`);
    }
  };
}
