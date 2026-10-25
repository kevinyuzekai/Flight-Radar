#!/usr/bin/env node
/**
 * 生成 macOS 应用图标 build/icon.icns（纯 Node：手写 PNG → iconset → iconutil）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const iconsetDir = path.join(buildDir, 'icon.iconset');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const S = 1024;
const SS = 2;
const pixels = Buffer.alloc(S * S * 4);

const ACCENT = [79, 230, 255];
const WHITE = [235, 252, 255];
const DEEP0 = [6, 14, 26];
const DEEP1 = [13, 32, 54];

function sdRoundRect(px, py, half, r) {
  const qx = Math.abs(px) - (half - r);
  const qy = Math.abs(py) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function planeInside(px, py) {
  const poly = [
    [0.0, -1.0], [0.09, -0.55], [0.10, -0.10],
    [0.64, 0.10], [0.64, 0.24], [0.10, 0.22],
    [0.09, 0.44], [0.30, 0.66], [0.30, 0.78], [0.055, 0.68],
    [0.05, 0.90], [0.15, 1.0], [0.15, 1.06], [-0.15, 1.06], [-0.15, 1.0], [-0.05, 0.90],
    [-0.055, 0.68], [-0.30, 0.78], [-0.30, 0.66], [-0.09, 0.44],
    [-0.10, 0.22], [-0.64, 0.24], [-0.64, 0.10], [-0.10, -0.10],
    [-0.09, -0.55],
  ];
  let inside = false;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
    const n = SS * SS;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const nx = ((x + (sx + 0.5) / SS) - S / 2) / (S / 2);
        const ny = ((y + (sy + 0.5) / SS) - S / 2) / (S / 2);

        if (sdRoundRect(nx, ny, 0.44, 0.105) > 0) continue;

        const t = Math.min(1, Math.max(0, (nx + ny + 1.1) / 2.2));
        let col = [
          DEEP0[0] + (DEEP1[0] - DEEP0[0]) * t,
          DEEP0[1] + (DEEP1[1] - DEEP0[1]) * t,
          DEEP0[2] + (DEEP1[2] - DEEP0[2]) * t,
        ];
        const rd = Math.hypot(nx, ny);
        const glow = Math.max(0, 1 - rd / 0.9) ** 2;
        col = [
          col[0] + ACCENT[0] * glow * 0.10,
          col[1] + ACCENT[1] * glow * 0.13,
          col[2] + ACCENT[2] * glow * 0.16,
        ];

        for (const rr of [0.17, 0.28, 0.39]) {
          if (Math.abs(rd - rr) < 0.008) {
            col = [col[0] + ACCENT[0] * 0.10, col[1] + ACCENT[1] * 0.12, col[2] + ACCENT[2] * 0.13];
          }
        }

        // 雷达扫描扇形
        let sweep = (Math.atan2(ny, nx) * 180) / Math.PI;
        sweep = (sweep + 360) % 360;
        if (rd < 0.42 && sweep > 292 && sweep < 350) {
          const k = 1 - (sweep - 292) / 58;
          col = [
            col[0] + ACCENT[0] * 0.13 * k,
            col[1] + ACCENT[1] * 0.15 * k,
            col[2] + ACCENT[2] * 0.16 * k,
          ];
        }
        if (rd < 0.42 && Math.abs(sweep - 350) < 1.1) col = [220, 250, 255];

        // 中央飞机
        if (planeInside(nx / 0.40, (ny + 0.01) / 0.40)) col = [WHITE[0], WHITE[1], WHITE[2]];

        rAcc += col[0];
        gAcc += col[1];
        bAcc += col[2];
        aAcc += 255;
      }
    }

    const idx = (y * S + x) * 4;
    pixels[idx] = Math.round(Math.min(255, rAcc / n));
    pixels[idx + 1] = Math.round(Math.min(255, gAcc / n));
    pixels[idx + 2] = Math.round(Math.min(255, bAcc / n));
    pixels[idx + 3] = Math.round(aAcc / n);
  }
}

fs.mkdirSync(iconsetDir, { recursive: true });

const sizes = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

function resize(srcSize, dstSize) {
  const out = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.min(srcSize - 1, Math.floor((x + 0.5) * scale));
      const sy = Math.min(srcSize - 1, Math.floor((y + 0.5) * scale));
      const si = (sy * srcSize + sx) * 4;
      const di = (y * dstSize + x) * 4;
      out[di] = pixels[si];
      out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2];
      out[di + 3] = pixels[si + 3];
    }
  }
  return out;
}

for (const [size, name] of sizes) {
  const data = size === S ? pixels : resize(S, size);
  fs.writeFileSync(path.join(iconsetDir, name), encodePng(size, size, data));
}
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePng(S, S, pixels));

try {
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], { stdio: 'inherit' });
  console.log('[icon] 已生成 build/icon.icns');
} catch (err) {
  console.warn('[icon] iconutil 失败: ' + err.message);
}

fs.rmSync(iconsetDir, { recursive: true, force: true });
