// 把 dist/ 与对局服务 server/ 打成 multitank-dist.tar.gz，方便上传到服务器
// （deploy.sh --mode dist 直接吃这个包：站点文件放 docroot，server/ 用来跑远端对战）
// 用法: node tools/pack-dist.mjs [输出文件路径]
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(projectRoot, 'dist');
const target = resolve(projectRoot, process.argv[2] ?? 'multitank-dist.tar.gz');

if (!existsSync(resolve(distDir, 'index.html'))) {
  console.error('[pack] no dist/index.html, run node tools/build.mjs first');
  process.exit(1);
}

rmSync(target, { force: true });

const serverDir = resolve(projectRoot, 'server');
const r = spawnSync(
  'tar',
  ['-czf', target, '-C', distDir, '.', '-C', projectRoot, 'server'],
  { stdio: 'inherit' },
);
if (r.error || r.status !== 0) {
  console.error('[pack] tar failed. Pack the contents of dist/ manually (without the dist folder itself),');
  console.error('       then deploy with: deploy.sh --mode dist --srcdir <extracted dir>');
  process.exit(1);
}

console.log(`[pack] wrote ${target} (dist + server${existsSync(serverDir) ? '' : ' — 缺少 server/'})`);
