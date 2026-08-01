#!/bin/bash
# ============================================================
# kumo-pi-stuff 一键备份脚本
# 把本地 pi 扩展 (~/.pi/agent/extensions/) 备份到本仓库并推送 GitHub
# 用法: ./scripts/backup-extensions.sh
# 可用环境变量:
#   EXT_DIR   扩展源目录(默认 ~/.pi/agent/extensions)
#   PUSH      设为 0 时只提交不推送
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="${EXT_DIR:-$HOME/.pi/agent/extensions}"
DEST_DIR="$REPO_DIR/backup/extensions"

echo "==> 源目录:   $EXT_DIR"
echo "==> 备份目录: $DEST_DIR"

if [ ! -d "$EXT_DIR" ]; then
  echo "!! 源目录不存在: $EXT_DIR" >&2
  exit 1
fi

# 1. 同步复制(增量 + 删除源中已不存在的文件)
echo "==> 同步复制扩展..."
mkdir -p "$DEST_DIR"
rsync -a --delete \
  --exclude ".DS_Store" \
  --exclude "node_modules" \
  --exclude "*.log" \
  "$EXT_DIR/" "$DEST_DIR/"

echo "==> 复制完成,内容:"
ls "$DEST_DIR"

# 2. git 提交
cd "$REPO_DIR"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
git add -A
if git diff --cached --quiet; then
  echo "==> 没有变化,无需提交"
else
  git commit -m "backup: 同步本地扩展 @ $TIMESTAMP"
  echo "==> 已提交"
fi

# 3. 推送
if [ "${PUSH:-1}" = "1" ]; then
  echo "==> 推送到 GitHub..."
  git push origin main
  echo "==> 推送完成 ✅"
else
  echo "==> PUSH=0,跳过推送(已提交但未推送)"
fi

echo "==> 全部完成"
