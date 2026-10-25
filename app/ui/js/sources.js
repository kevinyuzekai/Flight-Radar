'use strict';
/**
 * 数据源层：adsb.lol 与 adsb.fi
 *
 *  adsb.lol : 支持任意半径的点查询，一次 20000 NM 即可拿到全球近似全量（约 1.2 万架）
 *  adsb.fi  : 半径上限 250 NM，需按网格切块查询，但局部更新更密
 *
 * 模式：
 *   lol  —— 全球单次快照，最省请求
 *   fi   —— 视野内网格 / 全球热点轮换，局部更实时
 *   both —— lol 打底，fi 覆盖（同 hex 以 fi 为准）
 */
(function () {
  const FR = (window.FR = window.FR || {});
  const U = FR.util;

  const FIELDS = [
    'hex', 'flight', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate',
    'reg', 't', 'squawk', 'seen_pos', 'rssi', 'emergency', 'category', 'mlat', 'dst', 'dir', 'desc',
  ];

  const API = {
    lol: 'https://api.adsb.lol/v2/point/{lat}/{lon}/{dist}',
    fi: 'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}',
  };

  const FI_MAX_DIST = 250;

  /** 全球自适应采样点：航空流量最高的区域 */
  const HOTSPOTS = [
    // 欧洲
    { name: '西欧', lat: 50.5, lon: 4.5 }, { name: '英伦', lat: 52.5, lon: -1.5 },
    { name: '伊比利亚', lat: 40.2, lon: -3.7 }, { name: '北欧', lat: 59.3, lon: 18.0 },
    { name: '东欧', lat: 47.5, lon: 22.0 }, { name: '土耳其', lat: 41.0, lon: 29.0 },
    { name: '意大利', lat: 43.0, lon: 11.5 }, { name: '巴尔干', lat: 44.0, lon: 20.5 },
    // 北美
    { name: '美东', lat: 39.5, lon: -76.0 }, { name: '美东南', lat: 33.2, lon: -84.4 },
    { name: '美中', lat: 41.5, lon: -88.0 }, { name: '美西', lat: 37.5, lon: -122.2 },
    { name: '美西南', lat: 33.5, lon: -112.0 }, { name: '美南', lat: 30.0, lon: -95.3 },
    { name: '加西', lat: 49.2, lon: -123.1 }, { name: '加东', lat: 43.7, lon: -79.4 },
    { name: '墨西哥', lat: 19.4, lon: -99.1 }, { name: '阿拉斯加', lat: 61.2, lon: -149.9 },
    // 南美
    { name: '巴西南', lat: -23.4, lon: -46.6 }, { name: '阿根廷', lat: -34.6, lon: -58.4 },
    { name: '安第斯', lat: -12.0, lon: -77.0 }, { name: '巴西北', lat: -8.0, lon: -35.0 },
    // 东亚
    { name: '华东', lat: 31.2, lon: 121.5 }, { name: '华北京津', lat: 39.9, lon: 116.4 },
    { name: '华南', lat: 23.1, lon: 113.3 }, { name: '成渝', lat: 30.6, lon: 104.1 },
    { name: '日本', lat: 35.6, lon: 139.7 }, { name: '日本西', lat: 34.7, lon: 135.5 },
    { name: '韩国', lat: 37.5, lon: 127.0 }, { name: '台湾', lat: 25.0, lon: 121.5 },
    // 亚太
    { name: '东南亚', lat: 1.4, lon: 103.9 }, { name: '泰国', lat: 13.7, lon: 100.5 },
    { name: '越南', lat: 10.8, lon: 106.7 }, { name: '菲律宾', lat: 14.6, lon: 121.0 },
    { name: '印尼', lat: -6.2, lon: 106.8 }, { name: '印度西', lat: 19.1, lon: 72.9 },
    { name: '印度东', lat: 28.6, lon: 77.2 }, { name: '巴基斯坦', lat: 24.9, lon: 67.0 },
    { name: '澳洲东', lat: -33.9, lon: 151.2 }, { name: '澳洲西', lat: -31.9, lon: 115.9 },
    { name: '新西兰', lat: -37.0, lon: 174.8 },
    // 中东 / 非洲
    { name: '海湾', lat: 25.2, lon: 55.3 }, { name: '沙特', lat: 24.7, lon: 46.7 },
    { name: '埃及', lat: 30.0, lon: 31.2 }, { name: '东非', lat: -1.3, lon: 36.8 },
    { name: '西非', lat: 6.5, lon: 3.4 }, { name: '南非', lat: -26.1, lon: 28.0 },
    { name: '摩洛哥', lat: 33.6, lon: -7.6 },
    // 海洋航路（跨洋航班密集区）
    { name: '北大西洋西', lat: 48.0, lon: -40.0 }, { name: '北大西洋东', lat: 54.0, lon: -20.0 },
    { name: '格陵兰南', lat: 61.0, lon: -45.0 }, { name: '太平洋中', lat: 35.0, lon: -165.0 },
    { name: '太平洋东', lat: 30.0, lon: -140.0 }, { name: '印度洋', lat: 5.0, lon: 80.0 },
    { name: '南大西洋', lat: -10.0, lon: -25.0 }, { name: '北大西洋中', lat: 42.0, lon: -55.0 },
  ];

  /* ---------------- 状态 ---------------- */
  const aircraft = new Map();
  /** 一架飞机多久没有新定位就移除（毫秒） */
  const STALE_MS = 150000;

  const settings = {
    mode: 'both',
    fiMode: 'view',
    intervalMs: 10000,
    lolIntervalMs: 60000,
    lolRadius: 20000,
    showGround: false,
    maxAircraft: 12000,
    minAlt: 0,
  };

  let timer = null;
  let running = false;
  let inFlight = false;
  let lastFiTiles = [];
  let lastLolPlanes = [];
  let fiCursor = 0;
  let viewProvider = null;
  let onChange = null;

  const stats = {
    requests: 0,
    ok: 0,
    fail: 0,
    lastDuration: 0,
    fiTiles: 0,
    lolTotal: 0,
    fiTotal: 0,
  };

  /* ---------------- 网络 ---------------- */
  const bridge = window.flightRadar;

  async function getJson(url, { timeout = 22000 } = {}) {
    stats.requests += 1;
    if (!bridge || !bridge.fetchJson) {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, data: await res.json(), ms: 0, bytes: 0 };
    }
    const res = await bridge.fetchJson(url, { timeout, project: 'adsb' });
    if (res.ok) stats.ok += 1;
    else stats.fail += 1;
    return res;
  }

  /**
   * 把数据源返回的 ac/aircraft 转成对象数组。
   *
   * 两种格式都要吃：
   *   - Electron 主进程：扁平定长数组 + fields 表（省传输）
   *   - 原生 WKWebView：原始 ADS-B JSON（对象数组）
   */
  function rowsToObjects(data) {
    if (!data || typeof data !== 'object') return [];
    const list = Array.isArray(data.ac)
      ? data.ac
      : Array.isArray(data.aircraft)
        ? data.aircraft
        : [];
    if (!list.length) return [];

    const first = list[0];
    // 对象数组：直接用
    if (first && !Array.isArray(first) && typeof first === 'object') return list;

    // 扁平数组：按 fields 还原
    const fields = data.fields || FIELDS;
    const out = [];
    for (const row of list) {
      if (!Array.isArray(row)) continue;
      const obj = {};
      for (let i = 0; i < fields.length; i++) obj[fields[i]] = row[i];
      out.push(obj);
    }
    return out;
  }

  /* ---------------- 规范化 ---------------- */
  const MIL_PREFIX = ['RCH', 'RRR', 'CFC', 'IAM', 'MMF', 'GAF', 'FAF', 'CTM', 'NOW', 'BAF', 'NAF', 'PLF', 'AME', 'ASY', 'HERK'];
  const SPECIAL_TYPES = /^(C130|C30J|C5M|C17|KC10|KC35|KC46|E3TF|E6|E8|P8|RC135|U2|B52|F16|F35|F22|A400|C27J|C295)/;

  function normalize(raw, source) {
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    let alt = raw.alt_baro;
    if (alt !== 'ground') {
      alt = Number(alt);
      if (!Number.isFinite(alt)) alt = null;
    }

    const hex = String(raw.hex || '').toLowerCase();
    if (!hex) return null;

    const callsign = String(raw.flight || raw.callsign || '').trim().toUpperCase();
    const type = String(raw.t || raw.type_code || '').trim().toUpperCase();
    const gs = Number(raw.gs);
    const track = Number(raw.track);
    const vs = Number(raw.baro_rate ?? raw.geom_rate);
    const altGeom = Number(raw.alt_geom);
    const seenPos = Number(raw.seen_pos);

    const isMil =
      raw.mil === true ||
      raw.category === 'A7' ||
      (callsign && MIL_PREFIX.some((p) => callsign.startsWith(p))) ||
      (type && SPECIAL_TYPES.test(type));

    const now = Date.now();

    const plane = {
      hex,
      callsign: callsign || hex.toUpperCase(),
      lat,
      lon,
      alt: alt === 'ground' ? 'ground' : alt,
      altGeom: Number.isFinite(altGeom) ? altGeom : null,
      gs: Number.isFinite(gs) ? gs : null,
      track: Number.isFinite(track) ? track : null,
      vs: Number.isFinite(vs) ? vs : null,
      type: type || '—',
      reg: String(raw.r || raw.reg || '').trim() || '—',
      desc: String(raw.desc || '').trim(),
      squawk: String(raw.squawk || '').trim(),
      emergency: String(raw.emergency || 'none'),
      category: String(raw.category || ''),
      source,
      seenPos: Number.isFinite(seenPos) ? seenPos : null,
      rssi: Number(raw.rssi) || null,
      dst: Number(raw.dst) || null,
      isMil,
      updatedAt: now,
      // 定位的真实时刻 = 拉取时刻 - seen_pos。旧版直接把拉取时刻当定位时刻，
      // 外推时少算了 seen_pos 秒，下一帧数据一到飞机就被“拉回去”。
      posTime: now - (Number.isFinite(seenPos) ? Math.max(0, seenPos) * 1000 : 0),
    };
    return plane;
  }

  /* ---------------- 拉取 ---------------- */
  function lolUrl(radiusNm) {
    // 以南极点附近为圆心，半径足够大即可覆盖整个地球
    return API.lol.replace('{lat}', '-89.9').replace('{lon}', '0').replace('{dist}', String(radiusNm));
  }

  function fiUrl(lat, lon) {
    return API.fi
      .replace('{lat}', lat.toFixed(4))
      .replace('{lon}', lon.toFixed(4))
      .replace('{dist}', String(FI_MAX_DIST));
  }

  async function fetchLol() {
    const res = await getJson(lolUrl(settings.lolRadius), { timeout: 30000 });
    const ns = FR.state.sources.lol;
    ns.lastMs = res.ms;
    ns.lastAt = Date.now();
    if (!res.ok || !res.data) {
      ns.lastOk = false;
      ns.errors += 1;
      U.pushError('adsb.lol: ' + (res.error || 'HTTP ' + res.status));
      return { ok: false, planes: [] };
    }
    ns.lastOk = true;
    const planes = [];
    for (const r of rowsToObjects(res.data)) {
      const p = normalize(r, 'adsb.lol');
      if (p) planes.push(p);
    }
    ns.lastCount = planes.length;
    stats.lolTotal = planes.length;
    return { ok: true, planes };
  }

  /* ---- adsb.fi 网格 ---- */
  function tilesForView(rect, maxTiles = 8) {
    if (!rect) return [];
    const toDeg = 180 / Math.PI;
    let west = rect.west * toDeg;
    let south = rect.south * toDeg;
    let east = rect.east * toDeg;
    let north = rect.north * toDeg;
    if (east < west) east += 360;
    const lonSpan = east - west;
    const latSpan = north - south;
    if (!Number.isFinite(lonSpan) || !Number.isFinite(latSpan) || latSpan <= 0) return [];
    // 视野太广时网格块会落在无人海面：改用全球热点轮换
    if (lonSpan > 45 || latSpan > 32) return [];

    const targetStep = 4.4;
    let cols = Math.max(1, Math.min(6, Math.ceil(lonSpan / targetStep)));
    let rows = Math.max(1, Math.min(6, Math.ceil(latSpan / targetStep)));
    while (cols * rows > maxTiles) {
      if (cols >= rows && cols > 1) cols -= 1;
      else if (rows > 1) rows -= 1;
      else break;
    }

    const tiles = [];
    const dLon = lonSpan / cols;
    const dLat = latSpan / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const clat = south + dLat * (r + 0.5);
        const clon = U.wrapLon(west + dLon * (c + 0.5));
        if (clat > 84 || clat < -84) continue;
        tiles.push({ lat: clat, lon: clon });
      }
    }
    return tiles;
  }

  function tilesForGlobal(maxTiles = 12) {
    const tiles = [];
    const n = HOTSPOTS.length;
    for (let i = 0; i < Math.min(maxTiles, n); i++) {
      const spot = HOTSPOTS[(fiCursor + i) % n];
      tiles.push({ lat: spot.lat, lon: spot.lon, name: spot.name });
    }
    fiCursor = (fiCursor + maxTiles) % n;
    return tiles;
  }

  async function fetchFi() {
    const ns = FR.state.sources.fi;
    if (settings.fiMode === 'off') {
      ns.lastOk = false;
      return { ok: false, planes: [], skipped: true };
    }

    let tiles = [];
    if (settings.fiMode === 'view' && viewProvider) tiles = tilesForView(viewProvider(), 9);
    if (!tiles.length) tiles = tilesForGlobal(fiCursor === 0 ? 24 : 8);
    if (!tiles.length) return { ok: false, planes: [], skipped: true };

    lastFiTiles = tiles;
    stats.fiTiles = tiles.length;

    const started = Date.now();
    const results = await Promise.all(
      tiles.map((t) => getJson(fiUrl(t.lat, t.lon), { timeout: 18000 }).catch(() => ({ ok: false })))
    );

    let planes = [];
    let okCount = 0;
    for (const res of results) {
      if (res && res.ok && res.data) {
        okCount += 1;
        for (const r of rowsToObjects(res.data)) {
          const p = normalize(r, 'adsb.fi');
          if (p) planes.push(p);
        }
      }
    }
    // 相邻网格可能重复命中同一架
    const seen = new Set();
    planes = planes.filter((p) => (seen.has(p.hex) ? false : (seen.add(p.hex), true)));

    ns.lastMs = Date.now() - started;
    ns.lastAt = Date.now();
    ns.lastOk = okCount > 0;
    ns.lastCount = planes.length;
    stats.fiTotal = planes.length;
    if (!okCount) {
      ns.errors += 1;
      U.pushError('adsb.fi: 网格查询全部失败 (' + tiles.length + ' 块)');
    }
    return { ok: okCount > 0, planes, tiles: tiles.length };
  }

  /* ---------------- 主循环 ---------------- */
  function passesFilter(p) {
    if (!settings.showGround && p.alt === 'ground') return false;
    if (settings.minAlt > 0) {
      const a = p.alt === 'ground' ? 0 : Number(p.alt) || 0;
      if (a < settings.minAlt) return false;
    }
    return true;
  }

  let lastLolAt = 0;
  let lolBackoff = 0;   // 命中 429 后指数退避

  async function tick(force) {
    if (!running && !force) return;
    if (inFlight) return;
    inFlight = true;
    const t0 = performance.now();

    try {
      const jobs = [];
      const labels = [];
      const nowMs0 = Date.now();
      // adsb.lol 全球快照：限流约 60 次/分钟，这里按 60s 节奏（命中 429 会退避）
      if ((settings.mode === 'lol' || settings.mode === 'both') &&
          (force || nowMs0 - lastLolAt >= (lolBackoff || settings.lolIntervalMs))) {
        jobs.push(fetchLol().then((r) => { lastLolAt = Date.now(); lolBackoff = 0; return r; })
          .catch((e) => {
            const m = String((e && e.message) || e);
            if (m.includes('429')) {
              lolBackoff = Math.min(300000, Math.max(60000, (lolBackoff || 60000) * 2));
              U.pushError('adsb.lol 限流，' + Math.round(lolBackoff / 1000) + 's 后重试');
            }
            throw e;
          }));
        labels.push('lol');
      }
      if (settings.mode === 'fi' || settings.mode === 'both') { jobs.push(fetchFi()); labels.push('fi'); }

      const results = await Promise.all(jobs);
      let merged = [];

      const byLabel = {};
      labels.forEach((l, i) => { byLabel[l] = results[i]; });
      const lol = byLabel.lol, fi = byLabel.fi;

      if (!lol && !fi) {
        // 本轮没有发起任何请求（例如 lol 在退避中）：沿用现有数据继续外推
        merged = Array.from(aircraft.values());
      } else if (settings.mode === 'lol' || (!fi)) {
        merged = ((lol && lol.planes) || []).concat(
          lastLolPlanes.filter((p) => !(lol && lol.planes || []).some((q) => q.hex === p.hex))
        );
      } else if (settings.mode === 'fi' || (!lol)) {
        merged = ((fi && fi.planes) || []).concat(
          Array.from(aircraft.values()).filter((p) => !((fi && fi.planes) || []).some((q) => q.hex === p.hex))
        );
      } else {
        // 两个源都有同一架时，取定位时刻更新的那条，而不是固定让 adsb.fi 覆盖
        const map = new Map();
        for (const p of [...((lol && lol.planes) || []), ...((fi && fi.planes) || [])]) {
          const old = map.get(p.hex);
          if (!old || p.posTime > old.posTime) map.set(p.hex, p);
        }
        merged = Array.from(map.values());
      }
      lastLolPlanes = (lol && lol.planes) || lastLolPlanes;

      // 只前进不后退：比已有定位更旧（或相同）的数据不覆盖位置，
      // 避免较慢的源 / 缓存响应把飞机拉回到之前的位置。
      const nowMs = Date.now();
      merged = merged.map((p) => {
        const old = aircraft.get(p.hex);
        if (old && p.posTime <= old.posTime) {
          return Object.assign({}, p, {
            lat: old.lat, lon: old.lon, alt: old.alt, gs: old.gs, track: old.track, vs: old.vs,
            posTime: old.posTime, updatedAt: old.updatedAt,
          });
        }
        return p;
      });
      // 本轮没出现、但不久前还有定位的飞机保留（继续外推），过期才移除，避免闪烁
      const seenNow = new Set(merged.map((p) => p.hex));
      for (const old of aircraft.values()) {
        if (!seenNow.has(old.hex) && nowMs - old.posTime < STALE_MS && passesFilter(old)) merged.push(old);
      }

      merged = merged.filter(passesFilter);
      if (merged.length > settings.maxAircraft) {
        merged.sort((a, b) => {
          const aa = a.alt === 'ground' ? -1 : Number(a.alt) || 0;
          const bb = b.alt === 'ground' ? -1 : Number(b.alt) || 0;
          return bb - aa;
        });
        merged = merged.slice(0, settings.maxAircraft);
      }

      aircraft.clear();
      for (const p of merged) aircraft.set(p.hex, p);

      stats.lastDuration = performance.now() - t0;

      const st = FR.state;
      st.mode = settings.mode;
      st.aircraftCount = merged.length;
      st.lastUpdate = Date.now();

      if (onChange) onChange(merged);
    } catch (err) {
      U.pushError('tick: ' + (err && err.message));
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => tick(false), settings.intervalMs);
  }

  /* ---------------- 对外接口 ---------------- */
  const api = {
    start(opts = {}) {
      Object.assign(settings, opts);
      running = true;
      schedule();
      tick(true);
    },
    stop() {
      running = false;
      clearInterval(timer);
    },
    refreshNow() {
      return tick(true);
    },
    setMode(mode) {
      settings.mode = mode;
      FR.state.mode = mode;
      tick(true);
    },
    setFiMode(mode) {
      settings.fiMode = mode;
      tick(true);
    },
    setIntervalMs(ms) {
      settings.intervalMs = Math.max(2000, Number(ms) || 10000);
      schedule();
    },
    setLolRadius(nm) {
      settings.lolRadius = Number(nm) || 20000;
      tick(true);
    },
    setShowGround(v) {
      settings.showGround = !!v;
      tick(true);
    },
    setMaxAircraft(n) {
      settings.maxAircraft = Number(n) || 12000;
      tick(true);
    },
    setMinAlt(ft) {
      settings.minAlt = Number(ft) || 0;
      tick(true);
    },
    setViewProvider(fn) {
      viewProvider = fn;
    },
    onChange(fn) {
      onChange = fn;
    },
    get planes() {
      return Array.from(aircraft.values());
    },
    get byHex() {
      return aircraft;
    },
    get settings() {
      return settings;
    },
    get stats() {
      return stats;
    },
    get tiles() {
      return lastFiTiles;
    },
    HOTSPOTS,
  };

  FR.sources = api;
})();
