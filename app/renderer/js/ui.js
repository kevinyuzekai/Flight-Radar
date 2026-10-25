'use strict';
/**
 * HUD 交互层：把数据源与三维场景接到界面元素上，维护航班详情面板
 */
(function () {
  const FR = (window.FR = window.FR || {});
  const U = FR.util;
  const $ = U.$;

  let selected = null;
  let paused = false;
  let detailTimer = 0;
  let lastRenderAt = 0;

  /* ---------------- 顶栏状态 ---------------- */
  function updateStats(planes) {
    const st = FR.state;
    $('stat-count').textContent = U.fmtNumber(planes.length);
    $('stat-visible').textContent =
      U.fmtNumber(st.renderedCount - st.hiddenBackside) + ' / ' + U.fmtNumber(st.hiddenBackside);
    $('stat-fps').textContent = st.fps ? st.fps + ' fps' : '—';
    $('stat-source').textContent =
      { lol: 'adsb.lol', fi: 'adsb.fi', both: '双源合并' }[FR.sources.settings.mode] || '—';

    const stats = FR.sources.stats;
    $('side-info').textContent =
      `已渲染 ${U.fmtNumber(st.renderedCount)} · 请求 ${stats.ok}/${stats.requests} 成功` +
      (stats.fiTiles ? ` · fi 网格 ${stats.fiTiles}` : '');

    setDot('lol', st.sources.lol);
    setDot('fi', st.sources.fi);
  }

  function setDot(name, s) {
    const dot = $('dot-' + name);
    if (!dot) return;
    dot.classList.remove('ok', 'err', 'wait');
    if (!s.lastAt) dot.classList.add('wait');
    else if (s.lastOk) dot.classList.add('ok');
    else dot.classList.add('err');
    dot.title = s.lastAt
      ? `${s.lastOk ? '正常' : '失败'} · ${s.lastMs} ms · ${s.lastCount} 架 · 错误 ${s.errors}`
      : '尚未请求';
  }

  /* ---------------- 机型图例 ---------------- */
  const LEGEND = [
    ['a380', 'A380'],
    ['b747', 'B747'],
    ['widebody', '宽体'],
    ['a330', 'A330'],
    ['narrowbody', '窄体'],
    ['regional', '支线'],
    ['turboprop', '涡桨'],
    ['light', '通航'],
    ['heli', '直升机'],
    ['fighter', '战机'],
  ];

  function buildLegend() {
    const box = $('legend-icons');
    if (!box) return;
    for (const [cls, label] of LEGEND) {
      const item = document.createElement('div');
      item.className = 'li';
      const img = document.createElement('img');
      img.src = 'assets/planes/' + cls + '.png';
      img.alt = label;
      // 图例里统一高度，仅保留比例差异（真实大小差异在球面上体现）
      img.style.height = '22px';
      const span = document.createElement('span');
      span.textContent = label;
      item.appendChild(img);
      item.appendChild(span);
      box.appendChild(item);
    }
  }

  /* ---------------- 详情面板 ---------------- */
  const detail = $('detail');

  function showDetail(plane) {
    selected = plane;
    if (!plane) {
      detail.classList.add('hidden');
      clearInterval(detailTimer);
      return;
    }
    detail.classList.remove('hidden');
    renderDetail(plane);

    clearInterval(detailTimer);
    detailTimer = setInterval(() => {
      const fresh = FR.sources.byHex.get(plane.hex);
      if (fresh) renderDetail(fresh);
      else $('d-log').textContent = '该目标已不在最新数据中（可能已落地或离开接收范围）';
    }, 1000);
  }

  function tag(text, kind) {
    return `<span class="tag ${kind}">${text}</span>`;
  }

  function renderDetail(p) {
    const cls = FR.scene.classify(p);

    $('d-icon').innerHTML = `<img src="assets/planes/${cls}.png" alt="${cls}">`;
    $('d-callsign').textContent = p.callsign || p.hex.toUpperCase();
    const bits = [];
    if (p.type && p.type !== '—') bits.push(p.type);
    if (p.desc) bits.push(p.desc);
    if (p.reg && p.reg !== '—') bits.push(p.reg);
    $('d-model').textContent = bits.join(' · ') || '机型未知';

    const badges = [];
    if (p.source) badges.push(tag(p.source, 'cyan'));
    if (p.isMil) badges.push(tag('军用/特殊', 'violet'));
    if (p.emergency && p.emergency !== 'none') badges.push(tag('紧急: ' + p.emergency, 'red'));
    if (p.alt === 'ground') badges.push(tag('地面', 'gray'));
    else if (p.vs !== null && p.vs > 200) badges.push(tag('爬升', 'lime'));
    else if (p.vs !== null && p.vs < -200) badges.push(tag('下降', 'amber'));
    badges.push(tag('图标 ' + cls, 'gray'));
    $('d-badges').innerHTML = badges.join('');

    $('d-alt').textContent = U.fmtAlt(p.alt);
    $('d-gs').textContent = p.gs === null ? '—' : `${U.fmtNumber(p.gs)} kt`;
    $('d-track').textContent = U.fmtHdg(p.track);
    $('d-vrate').textContent = U.fmtVertRate(p.vs);
    $('d-type').textContent = p.type || '—';
    $('d-reg').textContent = p.reg || '—';
    $('d-hex').textContent = p.hex.toUpperCase();
    $('d-squawk').textContent = p.squawk || '—';
    $('d-pos').textContent = U.fmtLatLon(p.lat, p.lon);
    $('d-source').textContent = p.source || '—';
    $('d-rssi').textContent = p.rssi === null ? '—' : p.rssi.toFixed(1) + ' dBFS';
    $('d-seen').textContent = U.fmtAgo(p.seenPos ?? 0);

    const following = FR.scene.followHex === p.hex;
    $('btn-follow').textContent = following ? '取消跟随' : '跟随此机';
    $('btn-follow').classList.toggle('on', following);

    const log = $('d-log');
    log.innerHTML = '';
    const line = (k, v) => {
      const d = document.createElement('div');
      d.textContent = `${k}: ${v}`;
      log.appendChild(d);
    };
    line('高度(m)', p.alt === 'ground' ? '0' : U.fmtNumber((Number(p.alt) || 0) * FR.const.FT_TO_M));
    if (p.altGeom) line('几何高度', U.fmtAlt(p.altGeom));
    if (p.dst !== null) line('距接收站', p.dst.toFixed(0) + ' NM');
  }

  /* ---------------- 数据回调 ---------------- */
  function onData(planes) {
    if (FR.scene) FR.scene.sync(planes);
    lastRenderAt = Date.now();
    updateStats(planes);
    if (selected) {
      const fresh = FR.sources.byHex.get(selected.hex);
      if (fresh) {
        selected = fresh;
        renderDetail(fresh);
      }
    }
  }

  function onFollowChange(hex) {
    if (!selected) return;
    const btn = $('btn-follow');
    if (!btn) return;
    btn.textContent = hex === selected.hex ? '取消跟随' : '跟随此机';
    btn.classList.toggle('on', hex === selected.hex);
  }

  /* ---------------- 事件绑定 ---------------- */
  let setBasemap = () => {};

  function bind() {
    document.querySelectorAll('input[name="source-mode"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        FR.sources.setMode(input.value);
        U.toast('数据源 → ' + (input.value === 'both' ? '双源合并' : input.value));
      });
    });

    const seg = $('basemap-seg');
    setBasemap = (kind) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.basemap === kind));
      FR.scene.setBasemap(kind);
      FR.state.imagery = kind;
    };
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-basemap]');
      if (btn) setBasemap(btn.dataset.basemap);
    });

    $('toggle-labels').addEventListener('change', (e) => FR.scene.setReferenceVisible(e.target.checked));
    $('toggle-atmosphere').addEventListener('change', (e) => FR.scene.setAtmosphere(e.target.checked));
    $('toggle-labels-plane').addEventListener('change', (e) => {
      FR.state.showLabels = e.target.checked;
      FR.scene.setPlaneLabels(e.target.checked);
    });

    const rangeAlt = $('range-alt');
    rangeAlt.addEventListener('input', () => {
      $('out-alt').textContent = U.fmtNumber(rangeAlt.value) + ' ft';
    });
    rangeAlt.addEventListener('change', () => FR.sources.setMinAlt(Number(rangeAlt.value)));

    const rangeLimit = $('range-limit');
    rangeLimit.addEventListener('input', () => {
      $('out-limit').textContent = U.fmtNumber(rangeLimit.value);
    });
    rangeLimit.addEventListener('change', () => FR.sources.setMaxAircraft(Number(rangeLimit.value)));

    document.querySelectorAll('button[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => FR.scene.flyTo(btn.dataset.view));
    });

    $('btn-refresh').addEventListener('click', () => {
      U.toast('正在刷新…');
      FR.sources.refreshNow();
    });
    $('btn-pause').addEventListener('click', () => {
      paused = !paused;
      if (paused) {
        FR.sources.stop();
        $('btn-pause').classList.add('on');
        U.toast('已暂停自动刷新');
      } else {
        FR.sources.start();
        $('btn-pause').classList.remove('on');
        U.toast('已恢复自动刷新');
      }
    });
    $('btn-settings').addEventListener('click', () => $('settings-modal').classList.remove('hidden'));
    $('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));

    $('settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal') e.target.classList.add('hidden');
    });
    $('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
    $('help-modal').addEventListener('click', (e) => {
      if (e.target.id === 'help-modal') e.target.classList.add('hidden');
    });

    $('sel-interval').addEventListener('change', (e) => {
      FR.sources.setIntervalMs(Number(e.target.value) * 1000);
      U.toast('刷新间隔 ' + e.target.value + ' 秒');
    });
    $('sel-radius').addEventListener('change', (e) => {
      FR.sources.setLolRadius(Number(e.target.value));
      U.toast('adsb.lol 半径 ' + e.target.value + ' NM');
    });
    $('sel-fi-mode').addEventListener('change', (e) => FR.sources.setFiMode(e.target.value));
    $('toggle-showground').addEventListener('change', (e) => FR.sources.setShowGround(e.target.checked));

    $('detail-close').addEventListener('click', () => {
      showDetail(null);
      FR.scene.select(null);
    });
    $('btn-follow').addEventListener('click', () => {
      if (!selected) return;
      if (FR.scene.followHex === selected.hex) FR.scene.unfollow();
      else FR.scene.follow(selected.hex);
    });
    $('btn-locate').addEventListener('click', () => {
      if (!selected) return;
      FR.scene.unfollow();
      FR.scene.flyToPlane(selected, 320000);
    });
    $('btn-copy').addEventListener('click', () => {
      if (!selected) return;
      const p = selected;
      const text = [
        `航班号: ${p.callsign}`,
        `ICAO: ${p.hex.toUpperCase()}`,
        `注册号: ${p.reg}`,
        `机型: ${p.type}`,
        `高度: ${U.fmtAlt(p.alt)}`,
        `地速: ${p.gs === null ? '—' : p.gs.toFixed(0) + ' kt'}`,
        `航向: ${U.fmtHdg(p.track)}`,
        `位置: ${U.fmtLatLon(p.lat, p.lon)}`,
        `数据源: ${p.source}`,
      ].join('\n');
      if (window.flightRadar) window.flightRadar.copy(text);
      U.toast('航班信息已复制');
    });

    setupSearch();

    document.addEventListener('keydown', (e) => {
      const tagName = (e.target && e.target.tagName) || '';
      const inField = tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        $('search-input').focus();
        $('search-input').select();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || inField) return;

      switch (e.key) {
        case 'r':
        case 'R':
          FR.sources.refreshNow();
          U.toast('正在刷新…');
          break;
        case ' ':
          e.preventDefault();
          $('btn-pause').click();
          break;
        case 'f':
        case 'F':
          if (window.flightRadar) window.flightRadar.setFullscreen();
          break;
        case '/':
          e.preventDefault();
          $('search-input').focus();
          break;
        case 'Escape':
          if (!$('settings-modal').classList.contains('hidden')) $('settings-modal').classList.add('hidden');
          else if (!$('help-modal').classList.contains('hidden')) $('help-modal').classList.add('hidden');
          else if (selected) {
            showDetail(null);
            FR.scene.select(null);
          }
          break;
        case '1': setBasemap('satellite'); break;
        case '2': setBasemap('dark'); break;
        case '3': setBasemap('none'); break;
        default: break;
      }
    });
  }

  /* ---------------- 搜索 ---------------- */
  function setupSearch() {
    const input = $('search-input');
    const box = $('search-results');
    if (!input || !box) return;

    let items = [];
    let activeIndex = -1;

    function close() {
      box.classList.add('hidden');
      box.innerHTML = '';
      items = [];
      activeIndex = -1;
    }

    function render(list) {
      box.innerHTML = '';
      items = list;
      activeIndex = list.length ? 0 : -1;
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'search-empty';
        empty.textContent = '没有匹配的航班（只搜索当前已加载的目标）';
        box.appendChild(empty);
        box.classList.remove('hidden');
        return;
      }
      list.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'search-item' + (i === 0 ? ' active' : '');
        row.innerHTML =
          `<span class="cs">${p.callsign}</span>` +
          `<span class="meta">${[p.type, p.reg].filter((x) => x && x !== '—').join(' · ') || p.hex.toUpperCase()}</span>` +
          `<span class="alt">${U.fmtAltShort(p.alt)}</span>`;
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(p);
        });
        box.appendChild(row);
      });
      box.classList.remove('hidden');
    }

    function pick(p) {
      close();
      input.value = p.callsign;
      FR.scene.select(p.hex);
      FR.scene.flyToPlane(p, 300000);
      input.blur();
    }

    function search(q) {
      const query = q.trim().toUpperCase();
      if (!query) return close();
      const scored = [];
      for (const p of FR.sources.planes) {
        const cs = p.callsign.toUpperCase();
        const hex = p.hex.toUpperCase();
        const reg = (p.reg || '').toUpperCase();
        let score = -1;
        if (cs === query) score = 100;
        else if (hex === query) score = 98;
        else if (reg === query) score = 96;
        else if (cs.startsWith(query)) score = 80;
        else if (reg.startsWith(query)) score = 70;
        else if (cs.includes(query)) score = 60;
        else if (reg.includes(query)) score = 50;
        else if (hex.startsWith(query)) score = 40;
        else if ((p.type || '').toUpperCase() === query) score = 30;
        if (score > 0) scored.push({ p, score });
      }
      scored.sort((a, b) => b.score - a.score);
      render(scored.slice(0, 12).map((s) => s.p));
    }

    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), 90);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim()) search(input.value);
    });
    input.addEventListener('blur', () => setTimeout(close, 140));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        close();
        input.blur();
        e.stopPropagation();
        return;
      }
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = e.key === 'ArrowDown' ? (activeIndex + 1) % items.length : (activeIndex - 1 + items.length) % items.length;
        box.querySelectorAll('.search-item').forEach((row, i) => row.classList.toggle('active', i === activeIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = items[Math.max(0, activeIndex)];
        if (p) pick(p);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    document.documentElement.classList.toggle('mac', navigator.platform.toUpperCase().includes('MAC'));
    buildLegend();

    try {
      await FR.scene.init();
    } catch (err) {
      U.pushError('场景初始化失败: ' + (err && err.message));
      const t = document.querySelector('#loading .loading-text');
      if (t) t.textContent = '三维地球初始化失败：' + err.message;
      return;
    }

    FR.scene.onSelect((plane) => showDetail(plane));
    FR.scene.onFollowChange(onFollowChange);

    bind();
    FR.sources.setViewProvider(() => FR.scene.currentRect());
    FR.sources.onChange(onData);
    FR.scene.startRenderLoop();

    $('loading').classList.add('done');
    FR.state.ready = true;

    // 可见/背面计数每秒刷新一次（机位置帧里更新）
    setInterval(() => {
      if (!paused) updateStats(FR.sources.planes);
    }, 1000);

    FR.sources.start({ mode: 'both', intervalMs: 10000 });

    if (window.flightRadar && window.flightRadar.info) {
      window.flightRadar.info().then((info) => console.log('[Flight Radar]', info));
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
