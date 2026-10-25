'use strict';
/**
 * scene.js — 地球场景（轻量 WebGL 版，替换原先的 Cesium 实现）
 *
 * 对外接口与旧版保持一致，panel.js 只需改几处相机调用。
 * 职责：数据 → 位置外推 → 屏幕精灵；拖动/缩放/点选；跟踪与视角保存。
 */
(function () {
  const FR = (window.FR = window.FR || {});
  const GL = window.GLMath;
  const G = window.Globe;

  // 图集：5 列 × 2 行，10 类机型
  const ATLAS = { cols: 5, rows: 2 };
  const CLASS_ORDER = ['a380', 'b747', 'widebody', 'a330', 'narrowbody',
    'regional', 'turboprop', 'light', 'heli', 'fighter'];

  const state = {
    globe: null,
    canvas: null,
    selectedHex: null,
    followHex: null,
    home: { lat: 30.27, lon: 120.15 },
    dpr: Math.min(2, window.devicePixelRatio || 1),
    lastSprites: null,
    lastCam: null,
  };

  /** hex -> {plane, disp:{lat,lon}, hidden, age} */
  const planeIndex = new Map();
  let planes = [];
  let selectCb = null;
  let followCb = null;
  let savedView = null;
  let raf = 0;
  let lastTs = 0;
  let fps = 0;

  /* ---------------- 工具 ---------------- */

  function classRect(cls) {
    const i = Math.max(0, CLASS_ORDER.indexOf(cls));
    const cx = i % ATLAS.cols, cy = Math.floor(i / ATLAS.cols);
    return { ux: cx / ATLAS.cols, uy: cy / ATLAS.rows, uw: 1 / ATLAS.cols, uh: 1 / ATLAS.rows };
  }

  /** 高度色带：低空绿 → 中空青 → 高空白 */
  function altColor(alt) {
    const ft = alt === 'ground' ? 0 : Number(alt) || 0;
    const t = Math.max(0, Math.min(1, ft / 40000));
    const stops = [
      [0.00, [124, 240, 156]],
      [0.25, [79, 230, 255]],
      [0.60, [150, 210, 255]],
      [1.00, [240, 250, 255]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0 || 1);
        return c0.map((v, j) => (v + (c1[j] - v) * f) / 255);
      }
    }
    return [1, 1, 1];
  }

  function wrapLon(lon) {
    let v = lon;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    return v;
  }

  function altitudeMeters(p) {
    return p.alt === 'ground' ? 0 : Math.max(0, (Number(p.alt) || 0) * 0.3048);
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    const canvas = document.getElementById('globe');
    if (!canvas) throw new Error('找不到 #globe 画布');
    state.canvas = canvas;

    resize();
    state.globe = G.create(canvas, { lat: state.home.lat, lon: state.home.lon, dist: 7.0 });
    bindInteractions();
    window.addEventListener('resize', resize);
    return state.globe;
  }

  function resize() {
    const c = state.canvas;
    if (!c) return;
    const wrap = c.parentElement;
    const dpr = state.dpr;
    const w = Math.max(2, Math.round(wrap.clientWidth * dpr));
    const h = Math.max(2, Math.round(wrap.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  /* ---------------- 数据 ---------------- */

  function sync(list) {
    planes = (list || []).slice();
    planeIndex.clear();
    const now = Date.now();
    for (const p of planes) {
      planeIndex.set(p.hex, {
        plane: p,
        disp: { lat: p.lat, lon: p.lon },
        hidden: false,
        age: Math.max(0, now - (p.posTime || now)),
      });
    }
    if (state.followHex && !planeIndex.has(state.followHex)) {
      state.followHex = null;
      if (followCb) followCb(null);
    }
  }

  /* ---------------- 每帧 ---------------- */

  function advance(entry, now) {
    const p = entry.plane;
    const dt = Math.min(15000, Math.max(0, now - (p.posTime || now))) / 1000;
    let lat = p.lat, lon = p.lon;
    if (p.gs && p.track != null && p.gs > 5 && dt > 0) {
      const m = p.gs * 0.514444 * dt;
      const rad = (p.track * Math.PI) / 180;
      lat += (m * Math.cos(rad)) / 111320;
      lon += (m * Math.sin(rad)) / (111320 * Math.max(0.15, Math.cos((p.lat * Math.PI) / 180)));
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
    }
    entry.disp.lat = lat;
    entry.disp.lon = lon;
    entry.age = Math.max(0, now - (p.posTime || now));
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const s = state.globe;
    if (!s) return;
    const now = Date.now();

    // 平面相机平滑（拖动/缩放的手感来自这里）
    if (s.flat) {
      s.spanLon += (s.flatTargetSpan - s.spanLon) * 0.18;
      s.flatLon += (s.flatTargetLon - s.flatLon) * 0.18;
      s.flatLat += (s.flatTargetLat - s.flatLat) * 0.18;
    }

    // 相机平滑 + 自转
    if (state.followHex) {
      const e = planeIndex.get(state.followHex);
      if (e) {
        s.targetLat = Math.max(-80, Math.min(80, e.disp.lat));
        s.targetLon = e.disp.lon;
        s.targetDist = 4.6;
        s.spin = false;
      }
    } else if (s.spin && !s.drag) {
      s.targetLon += 0.02;
      if (s.targetLon > 180) s.targetLon -= 360;
    }
    s.lat += (s.targetLat - s.lat) * 0.28;
    s.lon += (s.targetLon - s.lon) * 0.28;
    s.dist += (s.targetDist - s.dist) * 0.22;

    // 先算相机，再按可见性生成精灵
    const camNow = s.flat ? null : G.camera(s);
    const w = s.canvas.width, h = s.canvas.height;
    const dpr = state.dpr;
    const out = [];

    for (const e of planeIndex.values()) {
      advance(e, now);

      let sx, sy, sz = 0;
      if (s.flat) {
        // 平面视图：按当前可视经纬范围换算，超出画面就跳过
        const fv = s.flatView;
        if (!fv) continue;
        const rel = ((e.disp.lon - fv.lonMin) % 360 + 360) % 360;
        if (rel > fv.span) { e.hidden = true; continue; }
        sx = (rel / fv.span) * w;
        sy = ((fv.latMax - e.disp.lat) / (fv.latMax - fv.latMin)) * (0.5 - fv.halfH / 2) * h / 0.5 / 2;
        // 上面的写法容易绕；直接用 NDC 高度换算
        sy = ((fv.latMax - e.disp.lat) / (fv.latMax - fv.latMin)) * (fv.halfH * h);
        sy = (h - fv.halfH * h) / 2 + sy;
        e.hidden = false;
      } else {
        const r = 1 + altitudeMeters(e.plane) / 6371000;
        const pt = GL.latLonToXYZ(e.disp.lat, e.disp.lon, r);
        // 地平线剔除：球背面的目标直接跳过
        if (!GL.isVisible(camNow.eye, pt, 1.0)) { e.hidden = true; continue; }
        e.hidden = false;
        const scr = GL.project(camNow.vp, pt, w, h);
        if (!scr) continue;
        sx = scr.x; sy = scr.y; sz = scr.z - 0.0015;  // 轻微偏置，避免被自身高度推到球体之后
      }

      const cls = e.plane.cls || 'narrowbody';
      const rect = classRect(cls);
      const isSel = e.plane.hex === state.selectedHex;
      const isWatch = !!e.plane.watched;
      const zoom = s.flat ? 1 : Math.max(0.55, Math.min(1.35, 8.0 / Math.max(1.06, s.dist)));
      const base = s.flat ? 3.4 : 7.5;
      const size = (isSel ? base * 1.35 : base) * dpr * zoom;

      out.push({
        x: sx, y: sy, z: sz, size,
        rot: ((e.plane.track || 0) * Math.PI) / 180,
        alpha: e.age > 25000 ? 0.45 : 1,
        color: isSel ? [1, 0.36, 0.30] : (isWatch ? [0.62, 1, 0.43] : altColor(e.plane.alt)),
        ux: rect.ux, uy: rect.uy, uw: rect.uw, uh: rect.uh,
        hex: e.plane.hex,
      });
    }

    updateHomeMark(s, camNow);

    G.draw(s, out);
    state.lastSprites = out;
    state.lastCam = camNow;

    const dt = ts - lastTs;
    lastTs = ts;
    if (dt > 0) fps = fps * 0.9 + (1000 / dt) * 0.1;
  }

  function updateHomeMark(s, cam) {
    const el = document.getElementById('homeMark');
    if (!el) return;
    const home = state.home;
    const w = s.canvas.width, h = s.canvas.height;
    let x, y, vis = true;
    if (s.flat) {
      const fv = s.flatView;
      if (!fv) { el.classList.add('hidden'); return; }
      const rel = ((home.lon - fv.lonMin) % 360 + 360) % 360;
      if (rel > fv.span) { el.classList.add('hidden'); return; }
      x = (rel / fv.span) * w;
      y = ((fv.latMax - home.lat) / (fv.latMax - fv.latMin)) * (fv.halfH * h);
      y = (h - fv.halfH * h) / 2 + y;
    } else {
      const pt = GL.latLonToXYZ(home.lat, home.lon, 1);
      vis = GL.isVisible(cam.eye, pt, 1.0);
      const scr = vis ? GL.project(cam.vp, pt, w, h) : null;
      if (!scr) vis = false; else { x = scr.x; y = scr.y; }
    }
    if (!vis) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const scale = s.canvas.clientWidth / Math.max(1, w);
    el.style.left = (x * scale) + 'px';
    el.style.top = (y * scale) + 'px';
    const label = document.getElementById('homeMarkLabel');
    if (label) label.textContent = state.homeName || '观察点';
  }

  function setHome(lat, lon, name) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    // 只更新标记与状态，不移动相机 —— 否则每轮数据推送都会把用户拖到的视角拽回观察点
    state.home = { lat, lon };
    state.homeName = name || state.homeName;
  }

  function startRenderLoop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /* ---------------- 选中 / 跟踪 ---------------- */

  function onSelect(cb) { selectCb = cb; }
  function onFollowChange(cb) { followCb = cb; }

  function select(hex) {
    state.selectedHex = hex || null;
    FR.state.selectedHex = state.selectedHex;
    if (!selectCb) return;
    const p = state.selectedHex ? FR.sources.byHex.get(state.selectedHex) || null : null;
    selectCb(p);
  }

  function follow(hex) {
    if (!hex || !planeIndex.has(hex)) return false;
    state.followHex = hex;
    if (followCb) followCb(hex);
    return true;
  }

  function unfollow() {
    if (!state.followHex) return;
    state.followHex = null;
    if (followCb) followCb(null);
  }

  /* ---------------- 视角 ---------------- */

  function flyHome(lat, lon) {
    const s = state.globe;
    if (!s) return;
    state.followHex = null;
    s.targetLat = lat != null ? lat : state.home.lat;
    s.targetLon = lon != null ? lon : state.home.lon;
    s.targetDist = 7.0;
    s.spin = false;
  }

  function saveView() {
    const s = state.globe;
    if (!s) return;
    savedView = { lat: s.targetLat, lon: s.targetLon, dist: s.targetDist };
  }

  function restoreView() {
    const s = state.globe;
    if (!s) return;
    if (savedView) {
      s.targetLat = savedView.lat;
      s.targetLon = savedView.lon;
      s.targetDist = savedView.dist;
      savedView = null;
    } else {
      flyHome();
    }
  }

  /** 视野矩形（弧度），供 sources.js 的 adsb.fi 网格使用 */
  function currentRect() {
    const s = state.globe;
    if (!s) {
      return { west: -Math.PI, south: -Math.PI / 2, east: Math.PI, north: Math.PI / 2 };
    }
    const toRad = Math.PI / 180;
    // 视角越远，覆盖范围越大
    const halfLat = Math.min(85, 10 + (s.dist - 1.6) * 17);
    const halfLon = Math.min(179, halfLat / Math.max(0.25, Math.cos((s.lat * toRad))));
    return {
      west: (s.lon - halfLon) * toRad,
      east: (s.lon + halfLon) * toRad,
      south: Math.max(-85, s.lat - halfLat) * toRad,
      north: Math.min(85, s.lat + halfLat) * toRad,
    };
  }

  /* ---------------- 交互 ---------------- */

  function bindInteractions() {
    const c = state.canvas;
    let dragging = false, lastX = 0, lastY = 0, moved = 0;

    c.addEventListener('mousedown', (e) => {
      dragging = true; moved = 0;
      lastX = e.clientX; lastY = e.clientY;
      state.globe.drag = true;
      state.globe.spin = false;
      c.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const s = state.globe;
      if (s.flat) {
        const fv = s.flatView || { span: s.spanLon, latMin: -90, latMax: 90 };
        const pxPerDegLon = state.canvas.clientWidth / Math.max(1, fv.span);
        const latSpan = Math.max(1, fv.latMax - fv.latMin);
        const pxPerDegLat = (fv.halfH * state.canvas.clientHeight) / latSpan;
        s.flatTargetLon = wrapLon(s.flatTargetLon - dx / pxPerDegLon);
        s.flatTargetLat = Math.max(-85, Math.min(85, s.flatTargetLat + dy / Math.max(0.2, pxPerDegLat)));
        return;
      }
      s.targetLon -= dx * 0.3;
      s.targetLat = Math.max(-80, Math.min(80, s.targetLat + dy * 0.3));
      if (s.targetLon > 180) s.targetLon -= 360;
      if (s.targetLon < -180) s.targetLon += 360;
    });

    window.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      state.globe.drag = false;
      c.style.cursor = 'default';
      if (moved < 6) pickAt(e);
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = state.globe;
      if (s.flat) {
        const f = Math.exp(Math.sign(e.deltaY) * 0.16);
        s.flatTargetSpan = Math.max(6, Math.min(360, s.flatTargetSpan * f));
        return;
      }
      s.targetDist = Math.max(1.06, Math.min(16.0, s.targetDist + Math.sign(e.deltaY) * 0.25));
      if (state.followHex) unfollow();
      s.spin = false;
    }, { passive: false });

    c.addEventListener('dblclick', () => {
      if (state.selectedHex) select(null);
      const s = state.globe;
      if (s && s.flat) {
        s.flatTargetSpan = 360;
        s.flatTargetLon = 0;
        s.flatTargetLat = 0;
        return;
      }
      flyHome();
    });
  }

  function pickAt(e) {
    const list = state.lastSprites;
    if (!list || !list.length) return;
    const rect = state.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (state.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (state.canvas.height / rect.height);

    let best = null, bestD = (18 * state.dpr) ** 2;
    for (const sp of list) {
      const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
      if (d < bestD) { bestD = d; best = sp.hex; }
    }
    if (best) select(best);
    else if (state.selectedHex) select(null);
  }

  /* ---------------- 导出 ---------------- */

  FR.scene = {
    init,
    startRenderLoop,
    sync,
    select,
    onSelect,
    follow,
    unfollow,
    onFollowChange,
    currentRect,
    flyHome,
    saveView,
    restoreView,
    planeIndex,
    state,
    setFlat(on) {
      if (!state.globe) return;
      const s = state.globe;
      s.flat = !!on;
      if (on) {
        state.followHex = null;
        s.flatTargetSpan = 360;
        s.flatTargetLon = 0;
        s.flatTargetLat = 0;
      }
    },
    get isFlat() { return !!(state.globe && state.globe.flat); },
    setHome,
    get followHex() { return state.followHex; },
    get fps() { return Math.round(fps); },
  };
})();
