#!/bin/bash
# 冒烟自检：启动 App、抓状态、截图，然后自动退出
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$ROOT/build/Flight Radar.app/Contents/MacOS/FlightRadar" ]; then
  echo "[smoke] 未构建，先运行 npm run build"
  exit 1
fi
rm -rf "${TMPDIR:-/tmp}/flight-radar-smoke"
timeout 180 "$ROOT/build/Flight Radar.app/Contents/MacOS/FlightRadar" --smoke-test
