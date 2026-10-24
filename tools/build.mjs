/**
 * 零依赖离线构建：用 Node 内置的 stripTypeScriptTypes 去掉类型标注，
 * 按原目录结构输出成 .js（源码里的 .js 导入说明符因此无需改写）。
 * 这样在没有 npm 网络的环境里也能直接跑；有网络时仍可走 vite。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { computeBuildFingerprint } from '../server/version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, '..'));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (typeof stripTypeScriptTypes !== 'function') {
  console.error('当前 Node 不支持 module.stripTypeScriptTypes，请升级到 Node 22.13+ / 24+');
  process.exit(1);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

let tsCount = 0;
let assetCount = 0;
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const target = join(distDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  if (file.endsWith('.ts')) {
    const code = readFileSync(file, 'utf8');
    const stripped = stripTypeScriptTypes(code, { mode: 'strip' });
    writeFileSync(target.replace(/\.ts$/, '.js'), stripped, 'utf8');
    tsCount++;
  } else {
    copyFileSync(file, target);
    assetCount++;
  }
}

// 版本清单：页面上展示、自检时核对，服务端也会把它作为 no-store 输出。
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const commit = gitCommit();
/** 握手与页脚都读这个 meta：一眼能看出玩家当前加载的是哪一次构建。 */
const appVersion = `${pkg.version ?? '0.0.0'}${commit ? `+${commit}` : ''}`;

// 指纹只算非入口文件：入口自己要写进 ?v=<指纹>，参与计算就成循环了。
const build = await computeBuildFingerprint(distDir, {
  ignore: (file) => relative(distDir, file) === 'index.html',
});

const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('/src/main.ts', `./main.js?v=${build}`)
  // 产物里 styles.css 就在 dist 根目录（src 目录结构被展平为 dist 根目录），
  // 因此不能沿用 vite 开发时的 /src/styles.css 路径。
  .replace('/src/styles.css', `./styles.css?v=${build}`)
  .replace(
    '<title>',
    `<meta name="app-version" content="${appVersion}" />\n    <meta name="app-build" content="${build}" />\n    <title>`,
  );
writeFileSync(join(distDir, 'index.html'), html, 'utf8');

const version = {
  version: pkg.version ?? '0.0.0',
  buildTime: new Date().toISOString(),
  gitCommit: commit,
  build,
};
writeFileSync(join(distDir, 'version.json'), `${JSON.stringify(version, null, 2)}\n`, 'utf8');

console.log(`构建完成：${tsCount} 个模块，${assetCount} 个资源 → ${distDir}`);
console.log(`版本：${version.version} · ${version.gitCommit ?? 'no-commit'} · ${version.build}`);
