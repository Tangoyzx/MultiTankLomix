/**
 * 只跑远端对战 WebSocket 的独立进程，给 nginx 反代用（部署模式 dist / build）。
 * 想省事可以用 tools/serve.mjs：静态站点与 ws 同一个端口，不需要 nginx 转发。
 *
 *   node server/start-match.mjs --port 8787 [--path /ws] [--root dist]
 */
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatchServer } from './matchServer.mjs';
import { PROJECT_ROOT, readVersion } from './version.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    port: Number(process.env.MATCH_PORT ?? 8787),
    host: process.env.MATCH_HOST ?? '127.0.0.1',
    path: process.env.MATCH_PATH ?? '/ws',
    root: resolve(process.env.MATCH_ROOT ?? PROJECT_ROOT, 'dist'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--path') options.path = argv[++i];
    else if (arg === '--root') options.root = resolve(argv[++i]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg.startsWith('--host=')) options.host = arg.slice(6);
    else if (arg.startsWith('--path=')) options.path = arg.slice(7);
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice(7));
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
// 站点里任何请求都只回一个状态行：真正的内容由 nginx 提供，这里只做对局中继。
const version = await readVersion(options.root, '0.0.0');
const http = createServer((req, res) => {
  if ((req.url ?? '/').split('?')[0] === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...version, stats: match.stats }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('match server');
});

const match = createMatchServer({
  path: options.path,
  serverVersion: version.version ?? '0.0.0',
  serverBuild: version.build ?? '',
});
match.ws.attach(http);

http.listen(options.port, options.host, () => {
  console.log(`对局服务已启动：ws://${options.host}:${options.port}${options.path}`);
  console.log(`版本：${version.version ?? 'unknown'} · ${version.build ?? '-'}`);
  console.log(`自检：http://${options.host}:${options.port}/healthz`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    match.close();
    http.close(() => process.exit(0));
  });
}
