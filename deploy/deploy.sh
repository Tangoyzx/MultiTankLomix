#!/usr/bin/env bash
# 双人坦克大战 —— 服务器部署脚本（幂等，可重复执行）
# 详细步骤见同目录 DEPLOY.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="8080"
DOCROOT="/var/www/multitank"
MODE="dist"
TARBALL=""
SRCDIR=""
REPO=""
BRANCH="main"
NO_FIREWALL=0
ROLLBACK=0
MATCH_INSTALLED=0
# 远端对战的对局服务（WebSocket）端口：nginx 反代 /ws 到它，只有本机可连
WSPORT="8787"
APP_DIR="/opt/multitank"

log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[warn]   %s\n' "$*" >&2; }
die()  { printf '[error]  %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'HELP'
用法: bash deploy.sh [选项]

  --mode  MODE        dist | build | serve，默认 dist
                      dist  解压已经构建好的 dist 包（服务器无需 Node，推荐）
                      build 服务器 git clone 源码后 node tools/build.mjs（需 Node >= 22.13）
                      serve 不装 nginx，用 node tools/serve.mjs + systemd 常驻（需 Node >= 18）
  --port  N           监听端口，默认 8080
  --wsport N          对局服务（WebSocket）端口，默认 8787；serve 模式与网页同端口
  --docroot PATH      站点根目录，默认 /var/www/multitank
  --appdir PATH       对局服务安装目录，默认 /opt/multitank
  --tarball PATH      dist 模式的 tar.gz（默认自动找 multitank-dist.tar.gz）
  --srcdir  PATH      已上传目录：dist 模式当成品目录，build/serve 模式当源码目录
  --repo   URL        build/serve 模式 git clone 的地址
  --branch NAME       默认 main
  --no-firewall       不动系统防火墙（只在云厂商安全组放行时加）
  --rollback          回滚到上一版本（DOCROOT.old）
  -h | --help         帮助
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)        PORT="${2:?--port 需要值}"; shift 2 ;;
    --wsport)      WSPORT="${2:?--wsport 需要值}"; shift 2 ;;
    --docroot)     DOCROOT="${2:?--docroot 需要值}"; shift 2 ;;
    --appdir)      APP_DIR="${2:?--appdir 需要值}"; shift 2 ;;
    --mode)        MODE="${2:?--mode 需要值}"; shift 2 ;;
    --tarball)     TARBALL="${2:?--tarball 需要值}"; shift 2 ;;
    --srcdir)      SRCDIR="${2:?--srcdir 需要值}"; shift 2 ;;
    --repo)        REPO="${2:?--repo 需要值}"; shift 2 ;;
    --branch)      BRANCH="${2:?--branch 需要值}"; shift 2 ;;
    --no-firewall) NO_FIREWALL=1; shift ;;
    --rollback)    ROLLBACK=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "未知参数: $1（--help 查看用法）" ;;
  esac
done

case "$MODE" in
  dist|build|serve) ;;
  *) die "--mode 只能是 dist / build / serve" ;;
esac

have_cmd() { command -v "$1" >/dev/null 2>&1; }

need_root() {
  if [[ "$(id -u)" != "0" ]]; then
    if have_cmd sudo; then SUDO="sudo"; else die "请用 root 运行，或先安装 sudo"; fi
  else
    SUDO=""
  fi
}

detect_pm() {
  if have_cmd apt-get; then echo apt; return; fi
  if have_cmd dnf;     then echo dnf; return; fi
  if have_cmd yum;     then echo yum; return; fi
  if have_cmd apk;     then echo apk; return; fi
  echo none
}

install_nginx() {
  if have_cmd nginx; then log "nginx 已安装: $(nginx -v 2>&1 | head -1)"; return; fi
  local pm; pm="$(detect_pm)"
  log "安装 nginx（包管理器: $pm）"
  case "$pm" in
    apt) export DEBIAN_FRONTEND=noninteractive
         $SUDO apt-get update -y && $SUDO apt-get install -y nginx curl ;;
    dnf|yum) $SUDO "$pm" install -y nginx curl ;;
    apk) $SUDO apk add --no-cache nginx curl ;;
    *) die "识别不到包管理器，请手动安装 nginx + curl 后重跑本脚本" ;;
  esac
}

check_node() {
  have_cmd node || die "找不到 node；build 模式需要 Node >= 22.13"
  local v maj min rest
  v="$(node -v | sed 's/^v//')"
  [[ "$v" =~ ^[0-9]+\.[0-9]+ ]] || die "无法解析 Node 版本: $(node -v)"
  maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
  if (( maj < 22 || (maj == 22 && min < 13) )); then
    die "Node v$v 过低，需要 >= 22.13；请升级 Node，或改用 --mode dist（先在别的机器构建好 dist）"
  fi
  log "Node 版本检查通过: v$v"
}

check_node_basic() {
  have_cmd node || die "找不到 node；serve 模式需要 Node >= 18"
  local v maj
  v="$(node -v | sed 's/^v//')"
  [[ "$v" =~ ^[0-9]+\.[0-9]+ ]] || die "无法解析 Node 版本: $(node -v)"
  maj="${v%%.*}"
  (( maj >= 18 )) || die "Node v$v 过低，serve 模式需要 >= 18"
  log "Node 版本检查通过: v$v"
}

find_tarball() {
  if [[ -n "$TARBALL" ]]; then
    [[ -f "$TARBALL" ]] || die "找不到 --tarball 指定的文件: $TARBALL"
    return
  fi
  local c
  for c in "$PWD/multitank-dist.tar.gz" "$PROJECT_DIR/multitank-dist.tar.gz" \
           "$SCRIPT_DIR/multitank-dist.tar.gz" "$HOME/multitank-dist.tar.gz" \
           "/tmp/multitank-dist.tar.gz" "/root/multitank-dist.tar.gz"; do
    if [[ -f "$c" ]]; then TARBALL="$c"; return; fi
  done
  die "dist 模式需要成品包：上传 multitank-dist.tar.gz，或用 --tarball 指定，或用 --srcdir 指向已解压的 dist 目录"
}

resolve_source_dir() {
  STAGE="$(mktemp -d /tmp/multitank-stage.XXXXXX)"
  case "$MODE" in
    dist)
      if [[ -n "$SRCDIR" ]]; then
        [[ -d "$SRCDIR" ]] || die "--srcdir 不是目录: $SRCDIR"
        cp -a "$SRCDIR"/. "$STAGE"/
      else
        find_tarball
        log "解包 $TARBALL"
        tar -xzf "$TARBALL" -C "$STAGE"
      fi
      ;;
    build)
      local src
      if [[ -n "$SRCDIR" ]]; then
        src="$SRCDIR"
      else
        [[ -n "$REPO" ]] || die "build 模式需要 --repo <git 地址> 或 --srcdir <源码目录>"
        src="$STAGE/repo"
        have_cmd git || die "缺少 git，无法克隆；请安装 git 或改用 --srcdir"
        log "克隆 $REPO ($BRANCH)"
        git clone --depth 1 --branch "$BRANCH" "$REPO" "$src"
      fi
      [[ -f "$src/tools/build.mjs" ]] || die "$src 里没有 tools/build.mjs，不是项目源码目录"
      check_node
      log "构建 dist"
      ( cd "$src" && node tools/build.mjs )
      [[ -f "$src/dist/index.html" ]] || die "构建后没有 dist/index.html"
      cp -a "$src/dist"/. "$STAGE"/
      ;;
    serve)
      if [[ -n "$SRCDIR" ]]; then
        if [[ -f "$SRCDIR/tools/build.mjs" ]]; then
          check_node
          ( cd "$SRCDIR" && node tools/build.mjs )
          cp -a "$SRCDIR/dist"/. "$STAGE"/
        else
          cp -a "$SRCDIR"/. "$STAGE"/
        fi
      else
        [[ -n "$REPO" ]] || die "serve 模式需要 --srcdir <目录> 或 --repo <git 地址>"
        have_cmd git || die "缺少 git，无法克隆；请安装 git 或改用 --srcdir"
        git clone --depth 1 --branch "$BRANCH" "$REPO" "$STAGE/repo"
        check_node
        ( cd "$STAGE/repo" && node tools/build.mjs )
        cp -a "$STAGE/repo/dist"/. "$STAGE"/
      fi
      ;;
  esac

  # 兼容 tar 包里多一层 dist/ 目录的情况
  if [[ ! -f "$STAGE/index.html" && -f "$STAGE/dist/index.html" ]]; then
    cp -a "$STAGE/dist"/. "$STAGE"/
    rm -rf "$STAGE/dist"
  fi
  [[ -f "$STAGE/index.html" && -f "$STAGE/main.js" ]] || die "成品目录不完整（缺 index.html 或 main.js）: $STAGE"
  log "成品就绪，共 $(find "$STAGE" -type f | wc -l | tr -d ' ') 个文件"
}

swap_docroot() {
  $SUDO mkdir -p "$(dirname "$DOCROOT")"
  if [[ -d "$DOCROOT" ]]; then
    log "备份旧版本到 ${DOCROOT}.old"
    $SUDO rm -rf "${DOCROOT}.old"
    $SUDO mv "$DOCROOT" "${DOCROOT}.old"
  fi
  $SUDO mkdir -p "$DOCROOT"
  $SUDO cp -a "$STAGE"/. "$DOCROOT"/
  $SUDO rm -rf "$STAGE"
  log "站点目录已更新: $DOCROOT"
}

do_rollback() {
  [[ -d "${DOCROOT}.old" ]] || die "没有可回滚的版本: ${DOCROOT}.old"
  $SUDO rm -rf "${DOCROOT}.new"
  $SUDO mv "$DOCROOT" "${DOCROOT}.new"
  $SUDO mv "${DOCROOT}.old" "$DOCROOT"
  $SUDO rm -rf "${DOCROOT}.new"
  log "已回滚到上一版本，请 reload 服务：systemctl reload nginx（serve 模式: systemctl restart multitank）"
}

write_nginx_conf() {
  local tpl="$SCRIPT_DIR/nginx-multitank.conf"
  [[ -f "$tpl" ]] || die "缺少模板文件: $tpl"
  $SUDO mkdir -p /etc/nginx/conf.d
  sed -e "s|__PORT__|${PORT}|g" -e "s|__DOCROOT__|${DOCROOT}|g" -e "s|__WSPORT__|${WSPORT}|g" "$tpl" \
    | $SUDO tee /etc/nginx/conf.d/multitank.conf >/dev/null
  log "写入 /etc/nginx/conf.d/multitank.conf（端口 $PORT，根目录 $DOCROOT，对局服务 $WSPORT）"
  $SUDO nginx -t || die "nginx 配置校验失败，站点未受影响，请按上面报错修掉后重跑"
}

reload_nginx() {
  if have_cmd systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^nginx'; then
    $SUDO systemctl enable nginx >/dev/null 2>&1 || true
    if systemctl is-active --quiet nginx; then
      $SUDO systemctl reload nginx
    else
      $SUDO systemctl start nginx
    fi
  elif have_cmd service; then
    $SUDO service nginx restart
  else
    $SUDO nginx -s reload || $SUDO nginx
  fi
  log "nginx 已 reload"
}

write_systemd_unit() {
  local node_bin; node_bin="$(command -v node)"
  $SUDO tee /etc/systemd/system/multitank.service >/dev/null <<UNIT
[Unit]
Description=MultiTankLomix static server
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=PORT=${PORT}
ExecStart=${node_bin} ${PROJECT_DIR}/tools/serve.mjs ${DOCROOT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now multitank
  log "systemd 服务 multitank 已启动（端口 $PORT）"
}

open_firewall() {
  if [[ "$NO_FIREWALL" == "1" ]]; then
    warn "已跳过系统防火墙放行，请自行放通 TCP ${PORT}"
    return
  fi
  if have_cmd ufw && $SUDO ufw status >/dev/null 2>&1; then
    $SUDO ufw allow "${PORT}/tcp" >/dev/null && log "ufw 已放行 TCP ${PORT}"
  elif have_cmd firewall-cmd && systemctl is-active --quiet firewalld; then
    $SUDO firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    $SUDO firewall-cmd --reload >/dev/null
    log "firewalld 已放行 TCP ${PORT}"
  else
    warn "没检测到运行中的 ufw/firewalld，请在腾讯云轻量控制台防火墙放行 TCP ${PORT}"
  fi
}

# 远端对战需要的对局服务：把 server/ 装到 APP_DIR，用 systemd 常驻，
# nginx 把 /ws 反代过来；serve 模式不需要它（网页与 ws 本来就同端口）。
install_match_service() {
  local src="$STAGE/server"
  if [[ ! -f "$src/start-match.mjs" ]]; then
    warn "成品里没有 server/start-match.mjs，跳过对局服务：远端对战不可用"
    warn "远端对战请改用 --mode serve（tools/serve.mjs 同时提供网页与 WebSocket）"
    return
  fi
  check_node_basic
  local node_bin; node_bin="$(command -v node)"
  $SUDO mkdir -p "$APP_DIR"
  $SUDO rm -rf "$APP_DIR/server"
  $SUDO cp -a "$src" "$APP_DIR/server"
  $SUDO tee /etc/systemd/system/multitank-match.service >/dev/null <<UNIT
[Unit]
Description=MultiTankLomix match server
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${node_bin} ${APP_DIR}/server/start-match.mjs --port ${WSPORT} --path /ws --root ${DOCROOT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now multitank-match
  MATCH_INSTALLED=1
  log "对局服务已启动：ws://127.0.0.1:${WSPORT}/ws"
}

verify() {
  have_cmd curl || die "缺少 curl，无法自检"
  local base="http://127.0.0.1:${PORT}"
  local code
  code="$(curl -s -o /tmp/multitank-index.html -w '%{http_code}' "$base/" || true)"
  [[ "$code" == "200" ]] || die "访问 ${base}/ 返回 ${code:-无响应}；查日志 /var/log/nginx/multitank.error.log"
  grep -q "双人坦克大战" /tmp/multitank-index.html || die "首页内容不对，可能指向了别的站点"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/main.js" || true)"
  [[ "$code" == "200" ]] || die "静态资源 main.js 返回 ${code:-无响应}"
  log "自检通过：/ 与 /main.js 均为 200"

  # 版本清单：客户端拿它判断要不要刷新，必须能取到而且是 no-store
  code="$(curl -s -o /tmp/multitank-version.json -w '%{http_code}' "$base/version.json" || true)"
  [[ "$code" == "200" ]] || die "/version.json 返回 ${code:-无响应}"
  grep -q '"build"' /tmp/multitank-version.json || die "/version.json 里没有 build 指纹"

  if [[ "$MATCH_INSTALLED" == "1" ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "$base/ws" || true)"
    [[ "$code" == "101" ]] || die "/ws 握手返回 ${code:-无响应}（期望 101），远端对战不可用"
    log "自检通过：/version.json 与 /ws 握手（101）"
  fi
}

summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  cat <<DONE

================ 部署完成 ================
模式      : ${MODE}
站点目录  : ${DOCROOT}
端口      : ${PORT}
远端对战  : $([[ "$MATCH_INSTALLED" == "1" ]] && echo "ws://127.0.0.1:${WSPORT}/ws（nginx /ws 已反代）" || echo "未启用（用 --mode serve 或让成品带上 server/）")
本机自检  : http://127.0.0.1:${PORT}
内网地址  : http://${ip:-内网IP}:${PORT}
外网访问  : http://公网IP:${PORT}   （记得在腾讯云轻量防火墙放行 TCP ${PORT}）
调试参数  : ?seed=123 固定地形   ?wind=0 关风   ?wind=5 强风
回滚      : bash ${SCRIPT_DIR}/deploy.sh --rollback --docroot ${DOCROOT}
日志      : /var/log/nginx/multitank.access.log / .error.log
==========================================
DONE
}

main() {
  need_root
  if [[ "$ROLLBACK" == "1" ]]; then do_rollback; exit 0; fi

  log "开始部署（mode=$MODE port=$PORT docroot=$DOCROOT）"
  resolve_source_dir
  swap_docroot

  if [[ "$MODE" == "serve" ]]; then
    check_node_basic
    write_systemd_unit
    # serve 模式网页与 WebSocket 同端口，握手自检直接打站点端口
    MATCH_INSTALLED=1
    WSPORT="$PORT"
  else
    install_nginx
    install_match_service
    write_nginx_conf
    reload_nginx
  fi

  open_firewall
  verify
  summary
}

main "$@"
