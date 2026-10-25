#!/usr/bin/env node
/**
 * 准备原生应用的运行时资源：
 *   1. 从 node_modules/cesium 复制 Cesium 到 app/cesium（只保留运行时真正用到的部分）
 *   2. 给体积大的文本资源预压缩成 .gz（原生协议处理会优先下发 .gz）
 *
 * 裁剪依据：
 *   - index.cjs / index.js   是 ES module 入口（约 9MB），浏览器里用不到 → 不复制
 *   - Assets/IAU2006_XYS     仅 Cesium ion 的精密星历用，本项目不用 → 不复制
 *   - Widgets 只保留 widgets.css 与少量图标
 *   - Workers 白名单：只留渲染/几何/影像真正会起的那几个
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
const dest = path.join(root, 'app', 'cesium');

if (!fs.existsSync(src)) {
  console.error('[runtime] 找不到 Cesium，请先 npm install');
  process.exit(1);
}

console.log('[runtime] 重建 app/cesium ...');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const keep = [
  'Cesium.js',
  'Assets/approximateTerrainHeights.json',
  'Assets/Textures/NaturalEarthII',
  'Assets/Textures/SkyBox',
  'Assets/Textures/moonSmall.jpg',
  'Assets/Textures/waterNormalsSmall.jpg',
  'Assets/Images',
  'Widgets/widgets.css',
  'Workers',
  'ThirdParty/Workers',
];

function copyRel(rel) {
  const from = path.join(src, rel);
  const to = path.join(dest, rel);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

for (const rel of keep) copyRel(rel);

/* Workers 白名单：Cesium 1.146 的 Workers 目录是 chunk 化的，运行时按需加载。
   这里保守起见按文件名特征筛选，保留所有可能被用到的渲染管线 worker。 */
const wdir = path.join(dest, 'Workers');
if (fs.existsSync(wdir)) {
  const all = fs.readdirSync(wdir);
  const keepRe = /(chunk|create|combine|transcode|decode|Geometry|Imagery|Terrain|primitive|Vector|Billboard|Label|Point|Polyline|compute)/i;
  let removed = 0;
  for (const f of all) {
    if (!keepRe.test(f) && !f.endsWith('.wasm')) {
      fs.rmSync(path.join(wdir, f), { force: true });
      removed += 1;
    }
  }
  console.log(`[runtime] Workers 保留 ${all.length - removed}/${all.length}`);
}

/* 预压缩：文本类资源 gzip 后由原生协议以 Content-Encoding: gzip 下发 */
function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

const GZ_EXT = new Set(['.js', '.css', '.json', '.txt', '.xml', '.svg']);
let gzCount = 0;
let gzRaw = 0;
let gzSmall = 0;

walk(dest, (file) => {
  const ext = path.extname(file).toLowerCase();
  if (!GZ_EXT.has(ext)) return;
  const raw = fs.readFileSync(file);
  if (raw.length < 4096) return; // 太小的没必要压
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (gz.length >= raw.length) return;
  fs.writeFileSync(file + '.gz', gz);
  gzCount += 1;
  gzRaw += raw.length;
  gzSmall += gz.length;
});

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`[runtime] 预压缩 ${gzCount} 个文本资源：${mb(gzRaw)} → ${mb(gzSmall)}`);
console.log(`[runtime] app/cesium 体积（含 .gz 备份）：${mb(dirSize(dest))}`);

/* 只统计运行时实际会下发的字节（.gz 优先） */
let served = 0;
walk(dest, (file) => {
  if (file.endsWith('.gz')) return;
  const gzPath = file + '.gz';
  served += fs.existsSync(gzPath) ? fs.statSync(gzPath).size : fs.statSync(file).size;
});
console.log(`[runtime] 实际下发体积：${mb(served)}`);
