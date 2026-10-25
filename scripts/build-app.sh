#!/bin/bash
# 组装原生 Flight Radar.app 并打包成压缩 DMG
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Flight Radar.app"
OUT="$ROOT/release"

echo "[build] 清理旧产物"
rm -rf "$APP" "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT"

echo "[build] 复制可执行文件与 Info.plist"
cp "$ROOT/native/bin/FlightRadar" "$APP/Contents/MacOS/FlightRadar"
chmod +x "$APP/Contents/MacOS/FlightRadar"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/AppIcon.icns"

echo "[build] 打包网页资源（剔除 Electron/开发残留）"
rsync -a \
  --exclude 'renderer/assets/plane*.png' \
  "$ROOT/app/" "$APP/Contents/Resources/app/"

echo "[build] 体积明细"
du -sh "$APP/Contents/Resources/app" "$APP/Contents/Resources/app/cesium" "$APP" 2>/dev/null || true

echo "[build] 整包 ad-hoc 签名（先签内部可执行文件，再签整个 .app）"
xattr -cr "$APP"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/FlightRadar"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "[build] 生成压缩 DMG（UDZO + zlib-level 9）"
STAGE="$ROOT/build/dmgstage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Flight Radar.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "Flight Radar" \
  -srcfolder "$STAGE" \
  -ov -format UDZO -imagekey zlib-level=9 \
  "$OUT/Flight Radar.dmg" >/dev/null

rm -rf "$STAGE"
echo "[build] 完成："
ls -lh "$OUT/Flight Radar.dmg"
