#!/bin/bash
# 组装菜单栏版 Flight Radar.app（含通知中心小组件），ad-hoc 签名并打包 DMG
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Flight Radar.app"
OUT="$ROOT/release"
TARGET="arm64-apple-macos13.0"
CACHE="${TMPDIR:-/tmp}/fr-swift-cache"

echo "[build] 编译主程序"
mkdir -p "$ROOT/native/bin" "$CACHE"
swiftc -O -target "$TARGET" -module-cache-path "$CACHE" -parse-as-library \
  "$ROOT"/native/App/*.swift -o "$ROOT/native/bin/FlightRadar"

echo "[build] 编译小组件扩展"
swiftc -O -target "$TARGET" -module-cache-path "$CACHE" -parse-as-library -application-extension \
  -module-name FlightRadarWidget "$ROOT/native/Widget/Widget.swift" \
  -framework WidgetKit -framework SwiftUI -o "$ROOT/native/bin/FlightRadarWidget"

echo "[build] 清理并组装"
rm -rf "$APP" "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$OUT"
cp "$ROOT/native/bin/FlightRadar" "$APP/Contents/MacOS/FlightRadar"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/AppIcon.icns"
rsync -a "$ROOT/app/ui/" "$APP/Contents/Resources/app/ui/"

APPEX="$APP/Contents/PlugIns/FlightRadarWidget.appex"
mkdir -p "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources"
cp "$ROOT/native/bin/FlightRadarWidget" "$APPEX/Contents/MacOS/FlightRadarWidget"
cp "$ROOT/native/Widget/Info.plist" "$APPEX/Contents/Info.plist"
cp "$ROOT/app/ui/tex/landmask.png" "$APPEX/Contents/Resources/landmask.png"
strip -x "$APP/Contents/MacOS/FlightRadar" "$APPEX/Contents/MacOS/FlightRadarWidget" || true

echo "[build] ad-hoc 签名（由内向外）"
xattr -cr "$APP"
codesign --force --sign - --entitlements "$ROOT/native/Widget/Widget.entitlements" "$APPEX"
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
du -sh "$APP"

STAGE="$ROOT/build/dmgstage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
echo "[build] 打包 DMG"
hdiutil create -volname "Flight Radar" -srcfolder "$STAGE" \
  -ov -format UDZO -imagekey zlib-level=9 "$OUT/Flight Radar.dmg" >/dev/null
rm -rf "$STAGE"
ls -lh "$OUT/Flight Radar.dmg"
