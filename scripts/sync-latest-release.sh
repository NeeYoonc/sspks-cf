#!/usr/bin/env bash
# 把 NeeYoonc/dsh-nas 最新 Release 的 SPK 同步到本套件源（R2）。
#
# 用法:
#   scripts/sync-latest-release.sh [--force] [--dry-run]
#
#   --force    即使 Release 未变化也重新索引并上传
#   --dry-run  不真正上传，只打印将执行的上传命令
#
# 环境变量:
#   DSH_REPO        默认 NeeYoonc/dsh-nas
#   PKG_DIR         默认 packages
#   R2_BUCKET       默认 sspks
#   UPLOAD_BACKEND  默认 wrangler（用本机 wrangler login）；CI 里设 s3（用 R2_* 密钥）
#   WRANGLER_CMD    默认 npx wrangler
#   PYTHON          默认 python
#
# 依赖: gh（已登录）、python；wrangler 后端还需要已 wrangler login
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${DSH_REPO:-NeeYoonc/dsh-nas}"
PKG_DIR="${PKG_DIR:-packages}"
BUCKET="${R2_BUCKET:-sspks}"
UPLOAD_BACKEND="${UPLOAD_BACKEND:-wrangler}"
WRANGLER_CMD="${WRANGLER_CMD:-npx wrangler}"
PYTHON="${PYTHON:-python}"
MARKER="$PKG_DIR/.synced-release"

FORCE=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

case "$UPLOAD_BACKEND" in
  wrangler|s3) ;;
  *) echo "UPLOAD_BACKEND 只能是 wrangler 或 s3（当前: $UPLOAD_BACKEND）" >&2; exit 2 ;;
esac

TAG="$(gh release view -R "$REPO" --json tagName -q '.tagName')"
if [ -z "$TAG" ] || [ "$TAG" = "null" ]; then
  echo "无法获取 $REPO 的最新 Release" >&2
  exit 1
fi
echo "最新 Release: $TAG"

if [ "$FORCE" = 0 ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$TAG" ]; then
  echo "已同步过 $TAG（--force 可强制重跑）"
  exit 0
fi

ASSETS=()
while IFS= read -r name; do
  [ -n "$name" ] && ASSETS+=("$name")
done < <(gh release view "$TAG" -R "$REPO" --json assets \
  -q '.assets[] | select(.name | endswith(".spk")) | .name')

if [ "${#ASSETS[@]}" -eq 0 ]; then
  echo "Release $TAG 没有 .spk 资产" >&2
  exit 1
fi

mkdir -p "$PKG_DIR"
for name in "${ASSETS[@]}"; do
  if [ -f "$PKG_DIR/$name" ]; then
    echo "已存在: $name"
  else
    echo "下载: $name"
    gh release download "$TAG" -R "$REPO" -D "$PKG_DIR" -p "$name" --clobber
  fi
done

prune_remote() {
  local base="$1"
  local stem="${1%.spk}"
  if [ "$UPLOAD_BACKEND" = "wrangler" ]; then
    "$WRANGLER_CMD" r2 object delete "$BUCKET/spk/packages/$base" >/dev/null 2>&1 || true
    for size in 72 120; do
      "$WRANGLER_CMD" r2 object delete "$BUCKET/spk/icons/${stem}_thumb_$size.png" >/dev/null 2>&1 || true
    done
  else
    "$PYTHON" - "$BUCKET" "spk/packages/$base" \
      "spk/icons/${stem}_thumb_72.png" "spk/icons/${stem}_thumb_120.png" <<'PY' || true
import sys
sys.path.insert(0, "tools")
from r2 import client_from_env

client = client_from_env(sys.argv[1])
for key in sys.argv[2:]:
    client.delete(key)
PY
  fi
}

# 旧版本的包不进索引：本地文件可以先删（远端对象等新索引上传后再删，避免下载 404）。
PRUNE_KEYS=()
shopt -s nullglob
for file in "$PKG_DIR"/*.spk; do
  base="$(basename "$file")"
  keep=0
  for name in "${ASSETS[@]}"; do
    if [ "$base" = "$name" ]; then keep=1; break; fi
  done
  if [ "$keep" = 0 ]; then
    echo "移除旧包: $base"
    rm -f "$file"
    PRUNE_KEYS+=("$base")
  fi
done

echo "重建索引..."
"$PYTHON" tools/index.py --pretty

UPLOAD_ARGS=(--upload --bucket "$BUCKET")
if [ "$UPLOAD_BACKEND" = "wrangler" ]; then
  UPLOAD_ARGS+=(--upload-backend wrangler --wrangler-cmd "$WRANGLER_CMD")
fi
if [ "$DRY" = 1 ]; then
  UPLOAD_ARGS+=(--dry-run)
fi
"$PYTHON" tools/index.py "${UPLOAD_ARGS[@]}"

# 新索引已经生效，再清理 R2 里的旧对象。
if [ "$DRY" = 0 ]; then
  for base in "${PRUNE_KEYS[@]}"; do prune_remote "$base"; done
fi

if [ "$DRY" = 0 ]; then
  printf '%s\n' "$TAG" > "$MARKER"
  echo "已同步 $TAG（Worker 索引缓存最多 5 分钟）"
fi
