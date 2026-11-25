#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# browser-bridge 服务器端一键部署（Debian / Ubuntu，systemd）
#
# 用法（每个用户跑一次，实例名就是用户标识）：
#     sudo bash install-server.sh --instance zhangsan --port 8765
#     sudo bash install-server.sh --instance lisi     --port 8766
#
# 做完了什么：建系统用户 → 建 venv 装依赖 → 生成 token → 写配置
#             → 装成 systemd 服务并启动（开机自启）
#
# 做完之后你会得到：
#     · 一个跑在 127.0.0.1:<port> 的实例（不直接对外，由 nginx 挡在前面）
#     · 一份配置：/etc/browser-bridge/<instance>.json（token 在里面）
#     · 扩展侧该填的完整地址会打印在最后
#
# 注意：服务端是**单客户端**设计，一个实例只服务一个人。
#       多人请用不同 --instance / --port 各跑一次，不要指望共用。
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTANCE=""
PORT=8765
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="browserbridge"
DATA_DIR="/var/lib/browser-bridge"
CONF_DIR="/etc/browser-bridge"
PIP_INDEX="https://pypi.org/simple/"

usage() {
  cat <<'EOF'
用法: sudo bash install-server.sh [选项]

  --instance <名字>   实例名，通常是用户名（必填，例如 zhangsan）
  --port <端口>       监听端口，默认 8765（每个实例必须不同）
  --dir <路径>        项目所在目录，默认自动推断（脚本的 ../..）
  --user <系统用户>   运行服务的系统用户，默认 browserbridge
  --pip-index <URL>   pip 源，默认 https://pypi.org/simple/
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}";     shift 2 ;;
    --dir)      SRC_DIR="${2:-}";  shift 2 ;;
    --user)     RUN_USER="${2:-}"; shift 2 ;;
    --pip-index) PIP_INDEX="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[注意] %s\033[0m\n' "$*"; }
die()  { printf '\033[31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 参数与环境检查 ──
[[ -n "$INSTANCE" ]] || { usage; die "必须指定 --instance"; }
[[ $EUID -eq 0 ]] || die "请用 sudo / root 运行（要建系统用户和写 systemd）"
[[ "$INSTANCE" =~ ^[a-zA-Z0-9_-]+$ ]] || die "实例名只能含字母数字下划线连字符：$INSTANCE"

command -v python3 >/dev/null || die "找不到 python3，请先 apt install python3 python3-venv"
PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' \
  || die "Python 版本过低（当前 $PY_VER），需要 3.10+"

[[ -f "$SRC_DIR/server/mcp_server.py" ]] \
  || die "在 $SRC_DIR 下找不到 server/mcp_server.py，请用 --dir 指定项目根目录"

# 端口占用检查：MCP 在跑时手工起的实例会因端口冲突 exit(2)，先拦下来
if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
  die "端口 $PORT 已被占用。确认没有重复部署，或换一个 --port"
fi

say "部署 browser-bridge"
echo "  实例名   : $INSTANCE"
echo "  端口     : $PORT"
echo "  项目目录 : $SRC_DIR"
echo "  Python   : $PY_VER"
echo "  运行用户 : $RUN_USER"

# ── 1. 系统用户与目录 ──
say "1/6 准备系统用户与目录"
if id "$RUN_USER" >/dev/null 2>&1; then
  echo "  用户 $RUN_USER 已存在，复用"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  echo "  已创建系统用户 $RUN_USER"
fi
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$DATA_DIR"
install -d -o root -g root -m 0750 "$CONF_DIR"
echo "  数据目录 $DATA_DIR、配置目录 $CONF_DIR 就绪"

# ── 2. 虚拟环境与依赖 ──
say "2/6 建虚拟环境并安装依赖"
if [[ ! -x "$SRC_DIR/server/.venv/bin/python" ]]; then
  python3 -m venv "$SRC_DIR/server/.venv"
  echo "  已创建 $SRC_DIR/server/.venv"
fi
"$SRC_DIR/server/.venv/bin/pip" install --quiet --upgrade pip
# 注意：某些公司/镜像源在本机 pip 下会返回空索引，所以默认走官方源
"$SRC_DIR/server/.venv/bin/pip" install --quiet -i "$PIP_INDEX" -r "$SRC_DIR/server/requirements.txt"
echo "  依赖安装完成：$("$SRC_DIR/server/.venv/bin/python" -c 'import websockets, mcp; print("websockets", websockets.__version__)')"

# ── 3. 生成 token ──
say "3/6 生成访问 token"
# 已经部署过就复用，别把用户手上的配置冲掉
CONF_FILE="$CONF_DIR/$INSTANCE.json"
if [[ -f "$CONF_FILE" ]]; then
  TOKEN="$(python3 - "$CONF_FILE" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('token') or '')
except Exception:
    print('')
PY
)"
fi
if [[ -z "${TOKEN:-}" ]]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  echo "  已生成新 token"
else
  echo "  复用已有配置里的 token（未重新生成）"
fi

# ── 4. 写配置 ──
say "4/6 写配置 $CONF_FILE"
cat > "$CONF_FILE" <<EOF
{
  "host": "127.0.0.1",
  "port": $PORT,
  "token": "$TOKEN",
  "heartbeat_seconds": 20,
  "call_timeout_seconds": 60,
  "max_message_mb": 64,
  "screenshot_dir": "$DATA_DIR/shots",
  "log_level": "INFO",
  "http_host": "127.0.0.1",
  "http_port": $((PORT + 1))
}
EOF
chown root:"$RUN_USER" "$CONF_FILE"
chmod 0640 "$CONF_FILE"          # token 在里头，别让其他用户读到
echo "  已写入（权限 0640，属主 root:$RUN_USER）"

# ── 5. systemd ──
say "5/6 安装 systemd 服务"
UNIT_SRC="$SRC_DIR/server/deploy/browser-bridge@.service"
[[ -f "$UNIT_SRC" ]] || die "找不到 $UNIT_SRC"
install -m 0644 "$UNIT_SRC" /etc/systemd/system/browser-bridge@.service
systemctl daemon-reload
systemctl enable --now "browser-bridge@$INSTANCE"
echo "  已启动 browser-bridge@$INSTANCE"

# ── 6. 自检 ──
say "6/6 自检"
sleep 2
if systemctl is-active --quiet "browser-bridge@$INSTANCE"; then
  echo "  服务状态：运行中"
else
  warn "服务没起来，看日志："
  journalctl -u "browser-bridge@$INSTANCE" -n 30 --no-pager || true
  die "部署失败，请按上面的日志排查"
fi
if command -v ss >/dev/null; then
  ss -ltn | grep ":${PORT}\b" >/dev/null && echo "  端口 $PORT：已监听" || warn "端口 $PORT 未见监听，检查日志"
fi

cat <<EOF

────────────────────────────────────────────────────────────
部署完成 ✅

扩展侧要填的地址（在扩展面板里，或由企业策略下发）：

    wss://<你的域名>/u/$INSTANCE/?token=$TOKEN

  目前实例只监听 127.0.0.1:$PORT，还需要在 nginx 里加一段
  wss 反代才能从外部访问：
      server/deploy/nginx-snippet.conf 里有现成的 location 片段

常用命令：

    systemctl status browser-bridge@$INSTANCE
    journalctl -u browser-bridge@$INSTANCE -f
    systemctl restart browser-bridge@$INSTANCE

再给别的用户开一个实例（换个实例名和端口）：

    sudo bash $0 --instance <另一个用户名> --port $((PORT + 1))

安全提醒：
  · token 等于这台浏览器控制权的钥匙，按人分发、不要共用
  · 服务端是单客户端设计，一个实例只服务一个人，别让两人连同一个端口
  · nginx 里的 MCP HTTP 端点（如果有）必须叠加认证
────────────────────────────────────────────────────────────
EOF
