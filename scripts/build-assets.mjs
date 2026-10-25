#!/usr/bin/env node
/**
 * 生成飞机剪影贴图 —— Flightradar24 风格，按机型真实尺寸区分。
 *
 * 关键点：每个机型用它自己的真实几何（机身长度 / 翼展 / 后掠角 / 发动机数量）
 * 画在不同的画布上，画布宽高比 = 真实翼展比。这样 A380 的图标天然比 CRJ 更宽更大，
 * 一眼就能分辨飞机大小 —— 这正是 FR24 的做法。
 *
 * 渲染：FR24 式黄色实心 + 细深色描边（在卫星图与深色底图上都清楚）；
 * 另出一套红色 `-sel` 版本用于选中目标。图形为本项目自绘，不使用 FR24 素材。
 * 运行时 billboard.color = WHITE，不再按高度染色。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'app', 'renderer', 'assets', 'planes');
fs.mkdirSync(outDir, { recursive: true });

/* ---------------- PNG 编码 ---------------- */
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

/* ---------------- 几何 ---------------- */
function insidePoly(x, y, poly) {
  let c = false;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}

/** 圆/椭圆（米坐标） */
function ellipse(cx, cy, rx, ry, n = 16) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/**
 * 后掠翼（米坐标，sym 为左右符号）
 *   rootY   翼根前缘 y
 *   rootX   翼根接机身处 x（绝对值）
 *   span    半翼展
 *   leSweep 前缘后掠角（弧度）
 *   rootChord / tipChord  翼根 / 翼尖弦长（米）
 */
function wing(sym, rootX, rootY, span, leSweep, rootChord, tipChord) {
  const tipY = rootY + Math.tan(leSweep) * span;
  return [
    [sym * rootX, rootY],
    [sym * span, tipY],
    [sym * span, tipY + tipChord],
    [sym * rootX, rootY + rootChord],
  ];
}

/* ---------------- 机型（真实尺寸，单位：米） ----------------
 * L = 机身长度, S = 翼展, FW = 机身宽, LE = 前缘后掠角(度), ENG = 发动机数
 */
const DEG = Math.PI / 180;
const TYPES = {
  // 空客 A380 —— 四发双层巨型
  a380: {
    L: 72.7, S: 79.8, FW: 7.1, LE: 33.5, ENG: 4, ENG_POS: [0.36, 0.63],
    ROOT_CHORD: 13.5, TIP_CHORD: 3.4, STAB_SPAN: 15.0, STAB_CHORD: 6.0, ENG_R: 1.65,
  },
  // 波音 747 —— 四发半双层
  b747: {
    L: 70.6, S: 64.4, FW: 6.5, LE: 37.5, ENG: 4, ENG_POS: [0.34, 0.62],
    ROOT_CHORD: 12.5, TIP_CHORD: 3.0, STAB_SPAN: 13.0, STAB_CHORD: 5.2, ENG_R: 1.45,
  },
  // 波音 777 / 空客 A350 —— 宽体双发
  widebody: {
    L: 66.8, S: 64.8, FW: 6.2, LE: 31.5, ENG: 2, ENG_POS: [0.34],
    ROOT_CHORD: 12.0, TIP_CHORD: 2.8, STAB_SPAN: 12.5, STAB_CHORD: 5.0, ENG_R: 1.85,
  },
  // 空客 A330 —— 宽体双发（略小）
  a330: {
    L: 58.8, S: 60.3, FW: 5.6, LE: 30.0, ENG: 2, ENG_POS: [0.34],
    ROOT_CHORD: 11.0, TIP_CHORD: 2.6, STAB_SPAN: 11.0, STAB_CHORD: 4.6, ENG_R: 1.5,
  },
  // 波音 737 / 空客 A320 —— 窄体双发干线
  narrowbody: {
    L: 39.5, S: 35.8, FW: 3.8, LE: 27.0, ENG: 2, ENG_POS: [0.33],
    ROOT_CHORD: 7.6, TIP_CHORD: 1.5, STAB_SPAN: 7.2, STAB_CHORD: 3.2, ENG_R: 0.95,
  },
  // 支线喷气 CRJ900 / E190
  regional: {
    L: 36.4, S: 24.9, FW: 2.7, LE: 24.0, ENG: 2, ENG_POS: [0.33],
    ROOT_CHORD: 6.4, TIP_CHORD: 1.6, STAB_SPAN: 5.6, STAB_CHORD: 2.6, ENG_R: 0.72,
  },
  // 涡桨 ATR72 / Dash-8（直翼）
  turboprop: {
    L: 27.2, S: 27.05, FW: 2.9, LE: 2.5, ENG: 2, ENG_POS: [0.32],
    ROOT_CHORD: 3.6, TIP_CHORD: 1.9, STAB_SPAN: 5.2, STAB_CHORD: 2.1, ENG_R: 0.62, PROP: true,
  },
  // 轻型通航 C172 / SR22（上单翼）
  light: {
    L: 8.3, S: 11.0, FW: 1.1, LE: 1.5, ENG: 0, ENG_POS: [],
    ROOT_CHORD: 1.6, TIP_CHORD: 1.2, STAB_SPAN: 3.4, STAB_CHORD: 0.9, HIGH_WING: true,
  },
  // 直升机 H135 / AS350
  heli: {
    L: 12.2, S: 10.2, FW: 1.6, LE: 0, ENG: 0, ENG_POS: [],
    ROOT_CHORD: 0, TIP_CHORD: 0, STAB_SPAN: 0, STAB_CHORD: 0, HELI: true,
  },
  // 战斗机 F-16 / F-35（三角翼）
  fighter: {
    L: 15.0, S: 9.96, FW: 1.0, LE: 40.0, ENG: 1, ENG_POS: [],
    ROOT_CHORD: 7.0, TIP_CHORD: 0.9, STAB_SPAN: 3.2, STAB_CHORD: 2.0, DELTA: true,
  },
};

/** 机型轮廓（米坐标，机头朝 -y） */
function buildMasks(t) {
  const polys = [];
  const noseY = -t.L / 2;
  const tailY = t.L / 2;
  // FR24 风格机身更“胖”一点，小图标下也看得清机身
  const fw = t.FW * (t.HELI ? 1 : 1.35);
  const halfS = t.S / 2;

  if (t.HELI) {
    // 机身
    polys.push([
      [0, noseY],
      [fw * 0.55, noseY + t.L * 0.10],
      [fw * 0.72, noseY + t.L * 0.28],
      [fw * 0.60, noseY + t.L * 0.50],
      [-fw * 0.60, noseY + t.L * 0.50],
      [-fw * 0.72, noseY + t.L * 0.28],
      [-fw * 0.55, noseY + t.L * 0.10],
    ]);
    // 尾梁
    polys.push([
      [-fw * 0.20, noseY + t.L * 0.42],
      [fw * 0.20, noseY + t.L * 0.42],
      [fw * 0.14, tailY],
      [-fw * 0.14, tailY],
    ]);
    // 主旋翼：两片十字桨叶
    const cy = noseY + t.L * 0.30;
    for (let r = 0; r < 2; r++) {
      const a = r === 0 ? 0 : Math.PI / 2;
      const dx = Math.cos(a) * halfS;
      const dy = Math.sin(a) * halfS;
      const px = -Math.sin(a) * 0.28;
      const py = Math.cos(a) * 0.28;
      polys.push([
        [px - dx, cy + py - dy],
        [-px - dx, cy - py - dy],
        [-px + dx, cy - py + dy],
        [px + dx, cy + py + dy],
      ]);
    }
    polys.push(ellipse(0, cy, 0.42, 0.42));
    // 尾旋翼
    polys.push(ellipse(0, tailY - 0.4, 0.55, 0.22));
    // 起落滑橇
    polys.push([
      [-halfS * 0.5, noseY + t.L * 0.72],
      [halfS * 0.5, noseY + t.L * 0.72],
      [halfS * 0.5, noseY + t.L * 0.80],
      [-halfS * 0.5, noseY + t.L * 0.80],
    ]);
    return polys;
  }

  // ---- 机身：尖机头 + 等宽中段 + 收窄尾锥 ----
  const noseTaper = t.L * (t.DELTA ? 0.20 : 0.13);
  const tailTaper = t.L * 0.16;
  polys.push([
    [0, noseY],
    [fw * 0.34, noseY + noseTaper * 0.55],
    [fw * 0.46, noseY + noseTaper],
    [fw * 0.50, noseY + noseTaper * 2.4],
    [fw * 0.50, tailY - tailTaper * 1.5],
    [fw * 0.40, tailY - tailTaper * 0.4],
    [fw * 0.22, tailY],
    [-fw * 0.22, tailY],
    [-fw * 0.40, tailY - tailTaper * 0.4],
    [-fw * 0.50, tailY - tailTaper * 1.5],
    [-fw * 0.50, noseY + noseTaper * 2.4],
    [-fw * 0.46, noseY + noseTaper],
    [-fw * 0.34, noseY + noseTaper * 0.55],
  ]);

  // ---- 主翼 ----
  const leSweep = t.LE * DEG;
  if (t.DELTA) {
    // 三角翼：翼根在后机身，前缘大后掠
    for (const sym of [1, -1]) {
      polys.push([
        [sym * fw * 0.5, t.L * 0.02],
        [sym * halfS, t.L * 0.34],
        [sym * halfS, t.L * 0.40],
        [sym * fw * 0.5, t.L * 0.30],
      ]);
    }
  } else {
    const rootY = t.HIGH_WING ? -t.L * 0.10 : -t.L * 0.02;
    for (const sym of [1, -1]) {
      polys.push(wing(sym, fw * 0.5, rootY, halfS, leSweep, t.ROOT_CHORD, t.TIP_CHORD));
    }
  }

  // ---- 平尾 ----
  const stabRootY = tailY - tailTaper * 1.2;
  for (const sym of [1, -1]) {
    polys.push(
      wing(sym, fw * 0.38, stabRootY, t.STAB_SPAN / 2, leSweep * 0.75, t.STAB_CHORD, t.STAB_CHORD * 0.55)
    );
  }

  // ---- 垂尾（俯视是一条带后掠的中线） ----
  polys.push([
    [-fw * 0.16, tailY - tailTaper * 2.1],
    [fw * 0.16, tailY - tailTaper * 2.1],
    [fw * 0.16, tailY],
    [-fw * 0.16, tailY],
  ]);

  // ---- 发动机吊舱：贴着机翼前缘向后延伸 ----
  const wingRootY = t.HIGH_WING ? -t.L * 0.10 : -t.L * 0.02;
  for (const frac of t.ENG_POS || []) {
    const spanX = halfS * frac;
    const leY = wingRootY + Math.tan(leSweep) * spanX;
    for (const sym of [1, -1]) {
      // 吊舱前半段伸出机翼前缘，后半段压在机翼下
      const cy = leY + t.ENG_R * 1.35;
      polys.push(ellipse(sym * spanX, cy, t.ENG_R, t.ENG_R * 2.9, 18));
      // 挂架
      polys.push([
        [sym * (spanX - t.ENG_R * 0.35), leY + t.ENG_R * 0.5],
        [sym * (spanX + t.ENG_R * 0.35), leY + t.ENG_R * 0.5],
        [sym * (spanX + t.ENG_R * 0.35), cy],
        [sym * (spanX - t.ENG_R * 0.35), cy],
      ]);
    }
  }

  // 机头单发（战斗机）
  if (t.DELTA) polys.push(ellipse(0, tailY - tailTaper * 0.9, fw * 0.42, fw * 0.5, 12));

  // ---- 螺旋桨盘 ----
  if (t.PROP) {
    polys.push(ellipse(0, noseY + t.L * 0.035, fw * 0.80, 0.35, 18));
  }

  return polys;
}

/* ---------------- 光栅化 ---------------- */
function render(t, pxPerM, fill) {
  // 画布尺寸按真实包围盒 + 边距
  const marginM = Math.max(t.L, t.S) * 0.075;
  const wM = t.S + marginM * 2;
  const hM = t.L + marginM * 2;

  // 小机型（无人机/通航/直升机）用统一 pxPerM 会太小，按最小高度回推比例
  const MIN_H = 64;
  const eff = Math.max(pxPerM, MIN_H / hM);
  const W = Math.max(20, Math.round(wM * eff));
  const H = Math.max(20, Math.round(hM * eff));
  const SS = 4;
  const NW = W * SS;
  const NH = H * SS;

  const sx = NW / wM;
  const sy = NH / hM;

  const toPx = (xm) => (xm + wM / 2) * sx;
  const toPy = (ym) => (ym + hM / 2) * sy;

  const polys = buildMasks(t);

  // 投影到画布坐标
  const pxPolys = polys.map((poly) => poly.map(([x, y]) => [toPx(x), toPy(y)]));

  // 1) 覆盖率
  const mask = new Uint8Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    const py = y + 0.5;
    for (let x = 0; x < NW; x++) {
      const px = x + 0.5;
      for (const poly of pxPolys) {
        if (insidePoly(px, py, poly)) {
          mask[y * NW + x] = 255;
          break;
        }
      }
    }
  }

  // 2) 描边：膨胀
  const R = Math.max(2, Math.round(SS * 0.45));
  const dil = new Uint8Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    for (let x = 0; x < NW; x++) {
      let hit = false;
      for (let dy = -R; dy <= R && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= NH) continue;
        const base = yy * NW;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= NW) continue;
          if (mask[base + xx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) dil[y * NW + x] = 255;
    }
  }

  // 3) 降采样合成
  const out = Buffer.alloc(W * H * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let bodyA = 0;
      let dilA = 0;
      for (let dy = 0; dy < SS; dy++) {
        const base = (y * SS + dy) * NW + x * SS;
        for (let dx = 0; dx < SS; dx++) {
          bodyA += mask[base + dx];
          dilA += dil[base + dx];
        }
      }
      bodyA *= inv;
      dilA *= inv;
      const o = (y * W + x) * 4;
      if (bodyA > 1) {
        out[o] = fill[0];
        out[o + 1] = fill[1];
        out[o + 2] = fill[2];
        out[o + 3] = Math.min(255, Math.round(bodyA * 1.6));
      } else if (dilA > 1) {
        out[o] = 40;
        out[o + 1] = 32;
        out[o + 2] = 8;
        out[o + 3] = Math.round(dilA * 0.95);
      }
    }
  }
  return { png: encodePng(W, H, out), W, H, wM, hM };
}

/* ---------------- 输出 ---------------- */
const YELLOW = [255, 204, 0];
const RED = [255, 59, 48];
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.rmSync(path.join(outDir, f));
const manifest = {};
// 以“米 → 像素”的比例绘图：base 高度 128px 对应约 45m 机身
const PX_PER_M = 2.05;

for (const [name, spec] of Object.entries(TYPES)) {
  // FR24 风格：普通黄色，选中红色。（@2x 版本运行时从未引用，已不再生成）
  const r = render(spec, PX_PER_M, YELLOW);
  const rs = render(spec, PX_PER_M, RED);
  fs.writeFileSync(path.join(outDir, `${name}.png`), r.png);
  fs.writeFileSync(path.join(outDir, `${name}-sel.png`), rs.png);
  manifest[name] = {
    width: r.W,
    height: r.H,
    aspect: +(r.W / r.H).toFixed(3),
    lengthM: spec.L,
    spanM: spec.S,
    spanOverLength: +(spec.S / spec.L).toFixed(3),
  };
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('[assets] 机型图标：');
for (const [name, m] of Object.entries(manifest)) {
  console.log(
    `  ${name.padEnd(11)} ${String(m.width).padStart(5)}x${String(m.height).padEnd(5)}` +
      `  翼展 ${String(m.spanM).padStart(5)}m  机身 ${String(m.lengthM).padStart(5)}m  ratio ${m.aspect}`
  );
}
