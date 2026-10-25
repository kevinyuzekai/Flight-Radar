'use strict';
/**
 * panel.js — 面板：数据（原生推送）→ Motion 状态 → 地球精灵 / 列表 / 计数
 * 所有显示（地球、列表、附近/头顶计数）都来自同一份 store。
 */
(function () {
  /**
   * 地球与飞机：由 scene.js（轻量 WebGL 地球）绘制，数据来自 sources.js。
   * 合并、外推（只前进不回退）、FR24 图标、选中变红、按高度着色的远景点、标签 LOD 全部一致；
   * 这里只负责把原生推送的数据转成 1.0.0 的飞机结构并喂给 FR.scene。
   */
  const FR = window.FR;
  const LIST_MAX = 24;
  const CLASS_ORDER = ['a380', 'b747', 'widebody', 'a330', 'narrowbody', 'regional', 'turboprop', 'light', 'heli', 'fighter'];

  const store = { payload: null, home: { lat: 30.27, lon: 120.15 }, radiusKm: 30, selected: null };

  let mode = 'world';
  let sceneReady = false;
  const $ = (id) => document.getElementById(id);

  const fmtDist = (km) => (km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km');
  const fmtAlt = (p) => (p.onGround ? 'GND' : p.altFt >= 1000 ? (p.altFt / 1000).toFixed(1) + 'k' : String(Math.max(0, p.altFt)));

  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 2200);
  }

  function sendNative(action, extra) {
    try { window.webkit.messageHandlers.radar.postMessage(Object.assign({ action }, extra || {})); } catch (e) { /* 浏览器调试 */ }
  }

  function goHome() {
    if (!sceneReady) return;
    FR.scene.unfollow();
    FR.scene.flyHome(store.home.lat, store.home.lon);
  }

  /* ---------- 列表 / 计数（同一份 store） ---------- */
  function planesByDistance() {
    return ((store.payload && store.payload.planes) || []).slice().sort((a, b) => a.distKm - b.distKm);
  }

  function renderCounts() {
    const pl = store.payload; if (!pl) return;
    const list = pl.planes || [];
    const overhead = list.filter((p) => p.distKm <= store.radiusKm).length;
    $('homeName').textContent = pl.homeName || '杭州';
    if (sceneReady && pl.homeLat != null) FR.scene.setHome(pl.homeLat, pl.homeLon, pl.homeName);
    $('nearbyCount').textContent = list.length + ' 架附近' + (overhead ? ` · ${overhead} 架在头顶` : '');
    $('statusDot').className = 'dot' + (pl.ok && !pl.error ? '' : ' err');
  }

  function renderPlanes() {
    const ul = $('planeList');
    const list = planesByDistance().slice(0, LIST_MAX);
    ul.innerHTML = '';
    $('emptyHint').classList.toggle('hidden', list.length > 0);
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'plane' + (p.watched ? ' watched' : '') + (p.hex === store.selected ? ' sel' : '');
      li.dataset.hex = p.hex;
      li.innerHTML =
        `<span class="cs">${p.callsign || p.hex.toUpperCase()}</span>` +
        `<span class="meta"><div class="type">${p.airline || ''}${p.airline ? ' · ' : ''}${p.typeName || p.type || '—'}</div>` +
        `<div class="dist">${fmtDist(p.distKm)} · ${p.dirText || ''}</div></span>` +
        `<span class="alt">${fmtAlt(p)}</span>`;
      li.addEventListener('click', () => select(store.selected === p.hex && FR.scene.followHex === p.hex ? null : p.hex));
      ul.appendChild(li);
    }
  }

  function renderAirports() {
    const ul = $('airportList');
    const list = (store.payload && store.payload.airports) || [];
    ul.innerHTML = list.length ? '' : '<li style="color:var(--faint);font-size:11px">数据不足</li>';
    list.forEach((ap, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank">${i + 1}</span><span class="ap-city">${ap.city}</span>` +
        `<span class="ap-code">${ap.code}</span><span class="ap-count">${ap.count}</span>`;
      ul.appendChild(li);
    });
  }

  /**
   * 选中 = 跟踪（与 1.0.0 相同的 FR.scene.follow：每帧以飞机为原点 lookAtTransform，飞机始终在地球视窗正中）。
   * 滚轮会退出跟踪（1.0.0 行为）；再点一次列表里的同一架重新居中；取消选中回到之前的视角。
   */
  function saveView() { FR.scene.saveView(); }
  function restoreView() { FR.scene.restoreView(); }
  function select(hex) {
    if (!sceneReady) { store.selected = hex || null; renderPlanes(); return; }
    const p = hex && FR.sources.byHex.get(hex);
    if (hex && !p) { toast('该机暂未出现在全球数据中，稍后再试'); return; }
    if (p) {
      if (!FR.scene.followHex && !FR.scene.state.selectedHex) saveView();
      FR.scene.select(hex);
      FR.scene.follow(hex);
      toast('跟踪 ' + p.callsign);
      sendNative('focus', { hex });
    } else {
      FR.scene.unfollow();
      if (store.selected) FR.scene.select(null);   // onSelect 里恢复之前的视角
      else restoreView();
    }
    renderPlanes();
  }

  function setMode(m) {
    mode = m;
    $('airportPanel').classList.toggle('hidden', m !== 'airports');
    const gw = document.querySelector('.globe-wrap');
    gw.classList.toggle('collapsed', m === 'airports');
    if (sceneReady) FR.scene.setFlat(m === 'world');
    const ov = gw.querySelector('.globe-overlay'); if (ov) ov.style.display = m === 'airports' ? 'none' : '';
    gw.style.height = m === 'airports' ? '44px' : '';
    if (m !== 'airports') setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    document.querySelector('.list-wrap').style.display = m === 'airports' ? 'none' : '';
    $('btnMode').textContent = m === 'airports' ? '✈️' : (m === 'world' ? '🗺️' : '🌍');
    if (m === 'airports') renderAirports();
  }

  /* ---------- 原生 → 页面 ---------- */
  window.renderRadar = function (data) {
    store.payload = data;
    if (typeof data.radiusKm === 'number') store.radiusKm = data.radiusKm;
    renderCounts();
    renderPlanes();
    if (mode === 'airports') renderAirports();
  };

  window.renderSettings = function (s) {
    if (typeof s.homeLat === 'number' && typeof s.homeLon === 'number' &&
        (s.homeLat !== store.home.lat || s.homeLon !== store.home.lon)) {
      store.home = { lat: s.homeLat, lon: s.homeLon };
      if (!store.selected) goHome();
    }
    store.radiusKm = s.radiusKm || store.radiusKm;
    $('homeName').textContent = s.homeName || '杭州';
    $('inLat').value = s.homeLat; $('inLon').value = s.homeLon; $('inName').value = s.homeName;
    $('inRadius').value = s.radiusKm;
    $('outRadius').textContent = s.radiusKm + ' km';
    $('radiusLabel').textContent = s.radiusKm + ' km 内';
    if ($('inRadiusFeed')) $('inRadiusFeed').value = String(s.feedRadiusNm || 250);
    if ($('inTypes')) $('inTypes').value = s.watchTypes || '';
    $('btnAlert').classList.toggle('on', !!s.alertEnabled);
    $('btnAlert').textContent = s.alertEnabled ? '拍机警报 开' : '拍机警报 关';
    const labels = { a380: 'A380', b747: 'B747', widebody: '宽体', a330: 'A330', narrowbody: '窄体', regional: '支线', turboprop: '涡桨', light: '通航', heli: '直升机', fighter: '战机' };
    const box = $('watchChips'); box.innerHTML = '';
    for (const cls of CLASS_ORDER) {
      const b = document.createElement('button');
      b.className = 'chip' + (s.watches && s.watches[cls] ? ' on' : '');
      b.textContent = labels[cls]; b.dataset.cls = cls;
      b.onclick = () => b.classList.toggle('on');
      box.appendChild(b);
    }
    renderCounts();
  };

  window.notifyAlert = (text) => toast(text, 'warn');

  /* 自检：原始定位 vs 当前绘制位置 */
  window.__frDebug = function (n) {
    const out = [], now = Date.now();
    for (const [hex, e] of FR.scene.planeIndex) {
      if (out.length >= (n || 6)) break;
      out.push({ hex, rawLat: e.plane.lat, rawLon: e.plane.lon, drawLat: +e.disp.lat.toFixed(5), drawLon: +e.disp.lon.toFixed(5),
        age: +((now - e.plane.posTime) / 1000).toFixed(1), gs: e.plane.gs, track: e.plane.track, hidden: e.hidden });
    }
    return JSON.stringify(out);
  };

  /* ---------- 交互 ---------- */
  function bind() {
    $('btnMode').onclick = () => {
      const next = mode === 'globe' ? 'world' : (mode === 'world' ? 'airports' : 'globe');
      setMode(next);
      toast(next === 'world' ? '全球视图 · 同时显示所有飞机' : (next === 'airports' ? '最繁忙机场' : '三维地球'));
    };
    $('btnAlert').onclick = () => {
      const on = !$('btnAlert').classList.contains('on');
      $('btnAlert').classList.toggle('on', on);
      $('btnAlert').textContent = on ? '拍机警报 开' : '拍机警报 关';
      sendNative('toggleAlert', { enabled: on });
      toast(on ? '拍机警报已开启' : '拍机警报已关闭');
    };
    $('btnSettings').onclick = () => { $('sheet').classList.remove('hidden'); sendNative('getSettings'); };
    $('sheetClose').onclick = () => $('sheet').classList.add('hidden');
    $('inRadius').oninput = () => { $('outRadius').textContent = $('inRadius').value + ' km'; };
    $('btnSave').onclick = () => {
      const watches = {};
      document.querySelectorAll('.chip').forEach((b) => { watches[b.dataset.cls] = b.classList.contains('on'); });
      sendNative('saveSettings', { settings: {
        homeLat: parseFloat($('inLat').value) || 30.2741,
        homeLon: parseFloat($('inLon').value) || 120.1551,
        homeName: $('inName').value || '杭州',
        radiusKm: parseFloat($('inRadius').value) || 30,
        watches,
        feedRadiusNm: parseInt($('inRadiusFeed') ? $('inRadiusFeed').value : '250', 10) || 250,
        alertEnabled: $('btnAlert').classList.contains('on'),
        watchTypes: $('inTypes') ? $('inTypes').value : '',
      } });
      $('sheet').classList.add('hidden');
      toast('设置已保存');
    };
    $('btnQuit').onclick = () => sendNative('quit');
    if ($('btnTestAlert')) $('btnTestAlert').onclick = () => { sendNative('testAlert'); toast('已发送测试通知'); };
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    bind();
    try {
      await FR.scene.init();
    } catch (err) {
      $('globeHint').textContent = '地球初始化失败: ' + err.message;
      return;
    }
    sceneReady = true;
    FR.scene.onSelect((plane) => {
      const prev = store.selected;
      store.selected = plane ? plane.hex : null;
      if (plane && FR.scene.followHex !== plane.hex) { if (!prev) saveView(); FR.scene.follow(plane.hex); }
      else if (!plane && prev) { FR.scene.unfollow(); restoreView(); }
      renderPlanes();
    });
    FR.scene.onFollowChange((hex) => { if (!hex && store.selected) toast('已退出跟踪 · 再点列表可重新居中'); });
    FR.scene.startRenderLoop();
    FR.scene.flyHome(store.home.lat, store.home.lon);
    // 全球飞机：与 1.0.0 相同的 sources.js（adsb.lol 全球 + adsb.fi 视野网格，双源按定位时刻合并，10s 轮询）
    FR.sources.setViewProvider(() => FR.scene.currentRect());
    FR.sources.onChange((planes) => {
      FR.scene.sync(planes);
      const air = planes.filter((p) => p.alt !== 'ground').length;
      $('globalCount').textContent = air.toLocaleString();
    });
    FR.sources.start({ mode: 'both', intervalMs: 10000 });
    if (store.selected) FR.scene.select(store.selected);
    setMode(mode);
    window.__FR_READY__ = true;
    sendNative('ready');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
