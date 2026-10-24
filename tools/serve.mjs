/**
 * 一体式服务：同一个端口同时托管静态站点与远端对战用的 WebSocket。
 * 部署与本地预览都用它（start-game.bat 也是），这样网页与 ws 同源，
 * 不需要额外配置跨域或 wss 证书。
 *
 *   node tools/serve.mjs [root] [--port 4173] [--host 0.0.0.0]
 */
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatchServer } from '../server/matchServer.mjs';
import { createStaticHandler } from '../server/static.mjs';
import { PROJECT_ROOT, readVersion } from '../server/version.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const options = { port: Number(process.env.PORT ?? 4173), host: process.env.HOST ?? '0.0.0.0' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else positional.push(arg);
  }
  options.root = resolve(process.cwd(), positional[0] ?? 'dist');
  return options;
}

export function createSiteServer(root, { version = '0.0.0', build = '', reconnectGraceMs } = {}) {
  const siteRoot = resolve(root);
  const handleStatic = createStaticHandler(siteRoot, { version });
  const server = createServer(handleStatic);
  // 握手里要回服务端构建指纹：客户端拿它和页面里的 app-build 比，不一致就提示刷新。
  const match = createMatchServer({ path: '/ws', serverVersion: version, serverBuild: build, reconnectGraceMs });
  match.ws.attach(server);
  return { server, match, siteRoot };
}

export async function startServer(options) {
  const {
    port = 0,
    host = '127.0.0.1',
    root = resolve(PROJECT_ROOT, 'dist'),
    reconnectGraceMs = process.env.TANK_RECONNECT_GRACE_MS,
  } = options;
  const version = await readVersion(resolve(root), '0.0.0');
  const site = createSiteServer(resolve(root), {
    version: version.version ?? '0.0.0',
    build: version.build ?? '',
    reconnectGraceMs,
  });
  await new Promise((done) => site.server.listen(port, host, done));
  const address = site.server.address();
  return {
    ...site,
    version,
    port: typeof address === 'object' && address ? address.port : port,
    async close() {
      site.match.close();
      // fetch 的 keep-alive 连接与残留的 ws 会让 close() 一直挂着，这里主动断开
      site.server.closeAllConnections?.();
      await new Promise((done) => site.server.close(done));
    },
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const version = await readVersion(options.root, '0.0.0');
  const site = createSiteServer(options.root, {
    version: version.version ?? '0.0.0',
    build: version.build ?? '',
  });
  site.server.listen(options.port, options.host, () => {
    const base = `http://localhost:${options.port}/`;
    console.log(`静态服务已启动： ${base}  (根目录 ${options.root})`);
    console.log(`版本：${version.version ?? 'unknown'} · ${version.gitCommit ?? 'no-commit'} · ${version.build ?? '-'}`);
    console.log(`远端对战 WebSocket：ws://localhost:${options.port}/ws`);
    console.log('缓存策略：入口 no-store，js/css no-cache（每次回源校验）');
  });
  return site;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
