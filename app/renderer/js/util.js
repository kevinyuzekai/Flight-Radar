'use strict';
/**
 * 通用工具：格式化、地理计算、状态导出
 * 全局命名空间：window.FR
 */
(function () {
  const FR = (window.FR = window.FR || {});

  const NM_TO_M = 1852;
  const FT_TO_M = 0.3048;
  const KT_TO_MS = 0.514444;

  FR.const = { NM_TO_M, FT_TO_M, KT_TO_MS };

  /* ---------------- 格式化 ---------------- */
  function fmtNumber(n, digits = 0) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtAlt(alt) {
    if (alt === 'ground') return '地面';
    if (alt === null || alt === undefined || Number.isNaN(Number(alt))) return '—';
    const ft = Number(alt);
    return `${fmtNumber(ft)} ft · ${fmtNumber(ft * FT_TO_M)} m`;
  }

  function fmtAltShort(alt) {
    if (alt === 'ground') return 'GND';
    if (alt === null || alt === undefined || Number.isNaN(Number(alt))) return '';
    const ft = Number(alt);
    if (ft >= 10000) return (ft / 1000).toFixed(ft % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(ft / 100) * 100);
  }

  function fmtVertRate(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const fpm = Number(v);
    const arrow = fpm > 60 ? '▲' : fpm < -60 ? '▼' : '▬';
    return `${arrow} ${fmtNumber(Math.abs(fpm))} ft/min`;
  }

  function fmtLatLon(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
    return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
  }

  function fmtHdg(deg) {
    if (deg === null || deg === undefined || Number.isNaN(Number(deg))) return '—';
    const d = ((Number(deg) % 360) + 360) % 360;
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return `${d.toFixed(0)}° ${dirs[Math.round(d / 45) % 8]}`;
  }

  function fmtAgo(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
    const s = Number(seconds);
    if (s < 1) return '刚刚';
    if (s < 60) return `${s.toFixed(0)} 秒前`;
    if (s < 3600) return `${(s / 60).toFixed(0)} 分钟前`;
    return `${(s / 3600).toFixed(1)} 小时前`;
  }

  /* ---------------- 地理 ---------------- */
  const R_EARTH_KM = 6371;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function wrapLon(lon) {
    let x = ((lon + 180) % 360) - 180;
    if (x < -180) x += 360;
    return x;
  }

  /* ---------------- 颜色 ---------------- */
  /** 高度色带：低空绿 → 中空青 → 高空白 */
  function altitudeColor(altFt) {
    const a = altFt === 'ground' ? 0 : Number(altFt) || 0;
    if (a <= 0) return '#8aa4b8';
    const t = Math.min(1, Math.max(0, a / 40000));
    const stops = [
      [0.0, [124, 240, 156]],
      [0.25, [79, 230, 255]],
      [0.6, [150, 210, 255]],
      [1.0, [240, 250, 255]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0 || 1);
        const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return '#ffffff';
  }

  /* ---------------- DOM ---------------- */
  function $(id) {
    return document.getElementById(id);
  }

  let toastTimer = 0;
  function toast(message, kind = '', duration = 2600) {
    const box = $('toast');
    if (!box) return;
    box.textContent = message;
    box.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    box.classList.remove('hidden');
    toastTimer = setTimeout(() => box.classList.add('hidden'), duration);
  }

  /* ---------------- 状态导出（供自检/冒烟测试） ---------------- */
  const state = {
    ready: false,
    mode: 'both',
    aircraftCount: 0,
    renderedCount: 0,
    hiddenBackside: 0,
    labelCount: 0,
    fps: 0,
    imagery: 'satellite',
    showLabels: true,
    sources: {
      lol: { lastOk: false, lastMs: 0, lastCount: 0, errors: 0, lastAt: 0 },
      fi: { lastOk: false, lastMs: 0, lastCount: 0, errors: 0, lastAt: 0 },
    },
    errors: [],
  };
  FR.state = state;
  window.__FR_STATE__ = state;

  function pushError(msg) {
    state.errors.push({ at: Date.now(), msg: String(msg).slice(0, 300) });
    if (state.errors.length > 30) state.errors.shift();
  }

  FR.util = {
    fmtNumber,
    fmtAlt,
    fmtAltShort,
    fmtVertRate,
    fmtLatLon,
    fmtHdg,
    fmtAgo,
    haversineKm,
    wrapLon,
    altitudeColor,
    $,
    toast,
    pushError,
  };
})();
