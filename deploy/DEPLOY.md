# 双人坦克大战 · 腾讯云轻量服务器部署说明

这份文档写给**在服务器上执行命令的人（或 DeepSeekHarness / 其它 Agent）**：按顺序执行即可，命令都可以重复执行（幂等）。

## 0. 先记住三件事

1. 构建产物 `dist/` 是**纯静态文件**（`index.html` + `main.js` + `styles.css` + 若干 js 模块），运行时**不需要 Node**，服务器只做静态托管。
2. 服务器上**已经有 DeepSeekHarness 在跑**，所以本游戏**不要占用 80/443 或 DSH 已用的端口**，默认 **8080**（`--port` 可改），并且要在腾讯云轻量控制台的防火墙放行。
3. `deploy/deploy.sh` 只做四件事：把成品放进站点目录 → 写 nginx 配置 → reload nginx → 本地 curl 自检。**不会碰 DSH 的任何文件，也不会抢现有站点**（新增独立 `server` block，不监听 80）。

## 1. 开始前先确认（在服务器上跑一遍）

```bash
id -u                                  # 期望 0（root）；非 root 需要有 sudo
head -2 /etc/os-release                # Ubuntu/Debian → apt；CentOS/TencentOS → yum/dnf
command -v nginx && nginx -v           # 有没有 nginx
node -v                                # 只有 build/serve 模式需要；dist 模式无所谓
ss -lntp                               # 看 DSH 与现有服务占了哪些端口，挑一个没被占用的
```

端口规则：选一个 `ss -lntp` 里没出现的。下文统一用 `8080`。

## 2. 流程 A（推荐）：本地构建 → 上传成品 → 服务器只托管

服务器不需要装 Node，也不需要拉代码，最稳。

### 2.1 开发机出包（Windows 也行）

```bash
node tools/build.mjs        # 产出 dist/
node tools/logictest.mjs    # 逻辑用例，必须全绿
node tools/domtest.mjs      # 界面用例，必须全绿
node tools/pack-dist.mjs    # 打成 multitank-dist.tar.gz（包内是 index.html/main.js/...，不含 dist 这一层）
```

没有 `tar` 时，把 `dist` 里的内容压成 zip 上传也可以，服务器解压后用 `--srcdir` 指向它。

### 2.2 上传到服务器

```bash
scp multitank-dist.tar.gz root@公网IP:/root/
scp -r deploy             root@公网IP:/root/multitank-deploy
```

方式不限（scp / 控制台文件管理 / 对象存储），只要服务器上能找到：

- `multitank-dist.tar.gz`
- `deploy/`（内有 `deploy.sh` 与 `nginx-multitank.conf`）

### 2.3 服务器执行部署

```bash
cd /root/multitank-deploy
sed -i 's/\r$//' deploy.sh     # 万一在 Windows 改过换行，先去掉 CRLF
chmod +x deploy.sh
bash deploy.sh --mode dist --port 8080 --docroot /var/www/multitank \
               --tarball /root/multitank-dist.tar.gz
```

脚本会自动：装 nginx（缺失时）→ 备份旧站点到 `/var/www/multitank.old` → 解压到 `/var/www/multitank` → 渲染 `nginx-multitank.conf` 写入 `/etc/nginx/conf.d/multitank.conf` → `nginx -t` → reload → 放行系统防火墙 → `curl` 自检。

看到 `自检通过：/ 与 /main.js 均为 200` 即成功。

### 2.4 放通外网

腾讯云轻量有**独立于系统的防火墙**：控制台 → 防火墙 → 添加规则 → 放行 **TCP 8080**，来源 `0.0.0.0/0`。这步不做，外网会一直转圈。

然后浏览器打开 `http://公网IP:8080/`，标题应为「双人坦克大战」。

## 3. 流程 B：在服务器上构建（Node >= 22.13 才可用）

```bash
bash deploy.sh --mode build --port 8080 --docroot /var/www/multitank \
               --repo <git仓库地址> --branch main
```

源码已上传到 `/root/MultiTankLomix` 时省掉 clone：

```bash
bash deploy.sh --mode build --port 8080 --srcdir /root/MultiTankLomix
```

`tools/build.mjs` 用 Node 内置的 `stripTypeScriptTypes`，**低于 22.13 直接报错**；低版本请回到流程 A。

> 当前工程还不是 git 仓库。要用 --repo 先在开发机 git init 并推到远端；更省事的做法是直接把整个项目目录打包上传到服务器，然后用 --srcdir 指向它。同样需要 
ode -v ≥ 22.13。

## 4. 流程 C：不装 nginx，用 Node 静态服务常驻

脚本会写 `/etc/systemd/system/multitank.service`，用 `tools/serve.mjs` 托管 `dist`，开机自启、崩溃自拉。需要 Node >= 18。

```bash
bash deploy.sh --mode serve --port 8080 --docroot /var/www/multitank \
               --tarball /root/multitank-dist.tar.gz
```

常用：`systemctl status|restart|stop multitank`，`journalctl -u multitank -f`。

## 5. 验收清单

- 打开 `http://公网IP:8080/`，出现主界面，「远端多人游玩」置灰。
- 点「本地双人游玩」→ 双方各选一款坦克 →「下一步」进入对局，地形随机、两辆坦克分列左右。
- 移动阶段：HUD 的左右按钮能开坦克，车身贴合地形起伏。
- 射击阶段：按住自己的坦克拖拽，镜头拉远且力度圆整圆可见；松手开火，命中扣血，结算后换人。
- 一方血量归零弹「左边/右边玩家胜利」，确认后回主界面。
- 手机竖屏访问同一地址，触摸操作与鼠标一致。

调试参数：`?seed=123` 固定地形、`?wind=0` 关风、`?wind=5` 强风。

## 6. 回滚

每次部署都把上一版留在 `<docroot>.old`：

```bash
bash deploy.sh --rollback --docroot /var/www/multitank
systemctl reload nginx          # serve 模式用 systemctl restart multitank
```

## 7. 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| `nginx -t` 报端口冲突 | 端口被 DSH 或其它站点占用，`ss -lntp` 确认后换 `--port` |
| 外网打不开，本机 curl 正常 | 腾讯云轻量控制台防火墙没放行该端口 |
| 打开是 nginx 欢迎页 / 别的站点 | 端口撞到已有 server；换端口，或确认 `/etc/nginx/conf.d/multitank.conf` 是否写入 |
| 白屏、控制台 404 | 站点目录指错层（应为含 `index.html` 的那层），检查 `ls /var/www/multitank` |
| 更新后玩家还是旧页面 | 入口已 `no-store`；让玩家强刷，或检查响应头 `Cache-Control: no-store` |
| `node -v` 低于 22.13 | 走流程 A，不要在服务器上构建 |
| 想挂在子路径（如 `/tank/`） | 产物用相对路径，直接加 `location /tank/ { alias /var/www/multitank/; }` 即可，无需重新构建 |

## 8. 相关文件

- [deploy.sh](deploy.sh)：部署 / 回滚脚本，`--help` 看全部参数
- [nginx-multitank.conf](nginx-multitank.conf)：nginx server 模板（`__PORT__` / `__DOCROOT__` 两个占位符）
- [tools/build.mjs](../tools/build.mjs)：零依赖构建，输出 `dist/`
- [tools/serve.mjs](../tools/serve.mjs)：零依赖静态服务器（`PORT` 环境变量指定端口）
- [tools/pack-dist.mjs](../tools/pack-dist.mjs)：把 `dist/` 打成 `multitank-dist.tar.gz`