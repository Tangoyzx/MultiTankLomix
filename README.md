# 双人坦克大战（网页版）

回合制炮击对决，PC 用鼠标、手机用手指都能玩。两名玩家在同一台设备上轮流操作自己的坦克：先移动，再按住自己的坦克向反方向拖拽蓄力开火。

## 运行

本机没有可用的 npm 网络也可以跑，构建与预览都是零依赖脚本（需要 Node 22.13+ / 24+）：

```bash
node tools/build.mjs        # src/*.ts 去类型后输出到 dist/
node tools/serve.mjs dist   # 打开 http://localhost:4173
```

装了依赖时也可以用 `npm run dev`（vite）或 `npm run build && npm run serve`。

### 一键启动（Windows 双击即可）

- [start-game.bat](D:/AIWorkSpace/MultiTankLomix/start-game.bat)：先清掉占用 4173 端口的旧服务（按端口找 PID 再 kill，重复 PID 会去重），然后构建、起静态服务、等端口就绪后自动打开 <http://localhost:4173>。服务器跑在标题为 `TankServer-4173` 的最小化窗口里。
- [stop-game.bat](D:/AIWorkSpace/MultiTankLomix/stop-game.bat)：只关服务，不动别的。
- 两个脚本都可以跟一个端口号参数，例如 `start-game.bat 5000` / `stop-game.bat 5000`。

## 玩法

- 主界面「本地双人游玩」进入选坦界面；「远端多人游玩」当前置灰，点了提示即将开放。
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

## 远端模式（接口已预留，未开放）

`Transport` 定义了握手、选择、开局、移动、开火五类命令，本地模式走 `LocalTransport`（空实现），远端可接 `RemoteTransport`（WebSocket 占位）或 `BroadcastTransport`（同浏览器多标签，`?mode=remote&seat=left&net=broadcast&room=x` 可用来验证两端的锁输入与回放）。

规则是：轮到自己时按本地方式操作并把指令发出去；轮到对方时 `inputLocked` 为真，本地输入被 `InputGate` 屏蔽，收到的移动/开火指令在本地客户端回放。开局前会比对配置哈希，不一致直接退回主界面。

## 自测

```bash
node tools/build.mjs && node tools/logictest.mjs   # 31 项纯逻辑用例
node tools/build.mjs && node tools/domtest.mjs     # 10 项界面用例（自带 DOM/Canvas 桩）
```

`tools/webtest.mjs` 是通过 CDP 驱动 Chromium 的真机验收脚本（可用 `CHROME_PATH` 指定浏览器），需要能启动浏览器的环境。

## 仓库与首次推送

```powershell
powershell -ExecutionPolicy Bypass -File tools\push-github.ps1
```

脚本会 `git add -A` → 首次提交（已有提交则跳过）→ 分支改名为 `main` → 绑定 origin 并 `git push -u origin main`。默认远端是 `https://github.com/Tangoyzx/MultiTankLomix`，可以用 `-Remote` 覆盖。首次 HTTPS 推送需要在浏览器或凭据管理器里完成 GitHub 登录（或用 PAT）。

## 部署到服务器（腾讯云轻量等）

产物 `dist/` 是纯静态文件，用 nginx 托管即可，服务器上不需要 Node。步骤与脚本见 [deploy/DEPLOY.md](deploy/DEPLOY.md)，摘要：

```bash
node tools/build.mjs && node tools/pack-dist.mjs   # 本地出包 multitank-dist.tar.gz
scp multitank-dist.tar.gz deploy root@<公网IP>:/root/
# 服务器上：
bash deploy/deploy.sh --mode dist --port 8080 --docroot /var/www/multitank
```

`deploy/deploy.sh` 幂等：备份旧站点到 `<docroot>.old`、写 `/etc/nginx/conf.d/multitank.conf`（独立端口，不抢 80，不影响同机的其它服务）、reload、放行防火墙、`curl` 自检；`--rollback` 可回滚，`--mode build` 在服务器构建（需 Node 22.13+），`--mode serve` 不装 nginx 而用 systemd 常驻 `tools/serve.mjs`。