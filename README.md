# 双人坦克大战（网页版）

回合制炮击对决，PC 用鼠标、手机用手指都能玩。两名玩家在同一台设备上轮流操作自己的坦克：先移动，再按住自己的坦克向反方向拖拽蓄力开火。

## 运行

本机没有可用的 npm 网络也可以跑，构建与预览都是零依赖脚本（需要 Node 22.13+ / 24+）：

```bash
node tools/build.mjs        # src/*.ts 去类型后输出到 dist/
node tools/serve.mjs dist   # 打开 http://localhost:4173
```

`tools/serve.mjs` 是**一体式服务**：同一个端口既托管网页，也提供远端对战用的 WebSocket（`ws://localhost:4173/ws`），网页与 ws 同源，不需要额外配跨域。装了依赖时也可以用 `npm run dev`（vite，只跑网页不带对局服务）或 `npm run build && npm run serve`。

只想单独跑对局服务（例如 nginx 反代网页、ws 走独立端口）：

```bash
node server/start-match.mjs        # 默认 ws://localhost:8787/ws，/healthz 可探活
```

端口都能覆盖：`PORT=8080`、`MATCH_PORT=9000`、掉线宽限 `TANK_RECONNECT_GRACE_MS=30000`。

### 一键启动（Windows 双击即可）

- [start-game.bat](D:/AIWorkSpace/MultiTankLomix/start-game.bat)：先清掉占用 4173 端口的旧服务（按端口找 PID 再 kill，重复 PID 会去重），然后构建、起静态服务、等端口就绪后自动打开 <http://localhost:4173>。服务器跑在标题为 `TankServer-4173` 的最小化窗口里。
- [stop-game.bat](D:/AIWorkSpace/MultiTankLomix/stop-game.bat)：只关服务，不动别的。
- 两个脚本都可以跟一个端口号参数，例如 `start-game.bat 5000` / `stop-game.bat 5000`。

服务默认监听 `0.0.0.0`，所以**同一局域网的另一台设备**用 `http://<本机内网IP>:4173/` 打开，双方都点「远端对战（快速匹配）」就能直接配成一局，不用部署到公网。

## 玩法

- 主界面有两个入口：「本地双人游玩」（同一台设备轮流操作）和「远端对战（快速匹配）」（连服务器排队，与另一台设备上的玩家自动配对）。
- 双方各选一款坦克后点「下一步」开始。回合顺序：左方先手，每回合 = 移动阶段 + 射击阶段。
- 移动：按住 HUD 的 ◀ ▶ 按钮沿地形行驶，消耗本回合移动力；车身会贴合地形，车顶朝地形法线方向。\n- 坡度：上坡陡过 `terrain.maxClimbSlope`（默认 1，约 45°）爬不上去；下坡上限更宽松，`terrain.maxDescendSlope`（默认 2.2，约 65°）。过不去的方向按钮会置灰，提示行会写明「某侧坡度过陡，过不去」。
- 射击：按住自己的坦克并拖拽，镜头自动拉远到能同时看见两辆坦克，虚线是无风条件下的预测弹道；松手开火，实弹受重力和风力影响。
- 瞄准取景会保证以炮塔为圆心的力度圆整圆都在屏幕内（半径按视口短边收缩），所以手机竖屏上任意角度、任意力度都拖得到。
- 拖拽原点始终是坦克的炮塔中心（不是按下瞬间的位置），因此镜头拉远后力度与提示线仍和坦克对齐；只点一下不拖拽则视为取消，不开火。
- 命中对方扣血，命中地形暂不破坏，飞出边界无事发生；结算完毕后换对方操作。
- 一方血量归零弹出「左边/右边玩家胜利」，确认后回到主界面。

## 参数配置

所有可调数值集中在 [src/config.ts](src/config.ts)：地图尺寸、地形噪声与出生平台、重力与空气阻力、风力档位、镜头取景与跟随、回合节奏、伤害与爆炸半径、输入手感、UI 尺寸、渲染细节、三种坦克的属性（移动力、射界、最大力度、血量、地形破坏半径）。

配置在运行时被冻结，改错会立刻报错。调试时可以用 URL 覆盖白名单内的键，例如 `?wind=5`、`?world.width=1400`；`?seed=123` 可以固定地形种子复现同一张地图。

## 远端双人（已开放）

主界面点「远端对战（快速匹配）」就进入匹配界面：连上服务器排队，只要再有一个人排队就自动配成一局，服务端分配席位（左方先手）和同一份随机种子。

整套链路都在仓库里，零依赖：

- [server/ws.mjs](server/ws.mjs)：WebSocket 服务端（帧编解码、ping/pong 心跳），接到 HTTP server 上。
- [server/matchServer.mjs](server/matchServer.mjs)：匹配与对局中继。`handshake`（带 `configHash` / `version` / `resumeToken`）→ `join` 排队 → 同 `configHash` 的两人 `matched` → `pick` 同步选择 → 双方 `ready` 后广播 `start` → `move` / `shot` / `sync` 原样转给对手。
- [src/net/RemoteTransport.ts](src/net/RemoteTransport.ts)：浏览器端真实 WebSocket，默认同源 `ws(s)://当前域名/ws`，断线后退避重连并带着 `resumeToken` 回到原席位。

对局规则：轮到自己时按本地方式操作并把指令发出去；轮到对方时 `inputLocked` 为真，本地输入被 `InputGate` 屏蔽，收到的移动/开火指令在本地回放。两端用同一份种子做确定性模拟，每回合结束再把快照以 `sync` 发给对手校正（只校正非操作方坦克与风向，特效随机另走一条流，避免两端消耗不同而分叉）。开局前比对配置哈希，版本或配置不一致直接退回主界面。

掉线处理：对手掉线后给 **20 秒**宽限（服务端 `TANK_RECONNECT_GRACE_MS`，默认 20000），HUD 显示重连倒计时；期间他带 `resumeToken` 重连能回到原席位继续打，超时才算他离开并判另一方获胜。

调试 URL：

- `?mode=remote&net=broadcast&room=x&seat=left`：同一浏览器开两个标签页对联，**不经过服务器**，用来验证锁输入与回放。
- `?server=ws://host:8787/ws`：覆盖对局服务地址（默认同源 `/ws`）。

## 版本与缓存策略

目标是不管谁、什么时候打开，拿到的都是最新版本，页面不会被浏览器缓存住：

- 构建时算 `dist` 内容指纹（排除 `index.html` 自身，避免循环），写进 `dist/version.json`（`version` / `buildTime` / `gitCommit` / `build`），并把入口里的资源改成 `./main.js?v=<指纹>`、`./styles.css?v=<指纹>`，同时注入 `<meta name="app-version">` 与 `<meta name="app-build">`。
- 服务端：`/`、`/index.html`、`/version.json` 一律 `no-store, must-revalidate`；其余 js/css 带 ETag + `no-cache, must-revalidate`，可以存但每次使用前必须回源校验（命中回 304）。`deploy/nginx-multitank.conf` 是同一套策略。
- 页面里 [src/net/versionCheck.ts](src/net/versionCheck.ts) 拿页面 meta 里的构建指纹，定期以 `no-store` 请求 `/version.json?t=<时间戳>`，与服务端不一致就在顶部弹「发现新版本，点此刷新」。开发模式（指纹为空或 `dev`）不做这个判断。

## 自测

```bash
node tools/build.mjs && node tools/logictest.mjs   # 34 项纯逻辑用例
node tools/build.mjs && node tools/domtest.mjs     # 17 项界面用例（自带 DOM/Canvas 桩）
node tools/nettest.mjs                             # 13 项网络用例（起真服务 + 真 WebSocket）
```

`nettest.mjs` 覆盖：缓存响应头、快速匹配、选坦开局、移动/开火/回合校正中继、掉线宽限与带 `resumeToken` 重连。`npm test` 一次跑完前三项。

`tools/webtest.mjs` 是通过 CDP 驱动 Chromium 的真机验收脚本（可用 `CHROME_PATH` 指定浏览器），包含两个独立页面经服务器快速匹配成局的用例，需要能启动浏览器的环境。

## 仓库与首次推送

```powershell
powershell -ExecutionPolicy Bypass -File tools\push-github.ps1
```

脚本会 `git add -A` → 首次提交（已有提交则跳过）→ 分支改名为 `main` → 绑定 origin 并 `git push -u origin main`。默认远端是 `https://github.com/Tangoyzx/MultiTankLomix`，可以用 `-Remote` 覆盖。首次 HTTPS 推送需要在浏览器或凭据管理器里完成 GitHub 登录（或用 PAT）。

## 部署到服务器（腾讯云轻量等）

产物 `dist/` 是纯静态文件，用 nginx 托管即可；**远端对战**额外需要一个常驻的 Node 对局服务（`server/`，零依赖），nginx 把 `/ws` 反代过去。步骤与脚本见 [deploy/DEPLOY.md](deploy/DEPLOY.md)，摘要：

```bash
node tools/build.mjs && node tools/pack-dist.mjs   # 本地出包 multitank-dist.tar.gz
scp multitank-dist.tar.gz deploy root@<公网IP>:/root/
# 服务器上：
bash deploy/deploy.sh --mode dist --port 8080 --wsport 8787 --docroot /var/www/multitank
```

`deploy/deploy.sh` 幂等：备份旧站点到 `<docroot>.old`、写 `/etc/nginx/conf.d/multitank.conf`（独立端口，不抢 80，不影响同机的其它服务）、装 `multitank-match` 这个 systemd 服务跑对局 ws、reload、放行防火墙、`curl` 自检（含 `/version.json` 与 `/ws` 握手）；`--rollback` 可回滚，`--mode build` 在服务器构建（需 Node 22.13+），`--mode serve` 不装 nginx 而用 systemd 常驻 `tools/serve.mjs`（网页与 ws 同端口，此时不需要 `--wsport`）。
