'use strict';
/**
 * 渲染层 → 原生层的桥接（WKWebView 环境）
 *
 * 原生外壳用 WKScriptMessageHandler 提供三个能力：
 *   1. fetchJson   —— 走 URLSession，绕开 WKWebView 的 CORS 限制
 *   2. copy / open / fullscreen / quit —— 调用系统能力
 *   3. 自定义 app:// 协议由原生侧直接服务，页面无需关心
 *
 * 没有原生桥时（浏览器里调试）自动退化为普通 fetch，方便单独跑。
 */
(function () {
  const FR = (window.FR = window.FR || {});

  const pending = new Map();
  let nextId = 1;

  function post(name, payload) {
    try {
      window.webkit.messageHandlers[name].postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }

  /** 原生回调入口（Swift 侧用 evaluateJavaScript 调用） */
  window.__nativeFetchDone = function (id, status, ms, text) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    entry.resolve({ ok: status >= 200 && status < 300, status, ms, bytes: text.length, data });
  };

  window.__nativeFetchFail = function (id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.resolve({ ok: false, error, ms: 0, bytes: 0, data: null });
  };

  const hasNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fetch);

  /**
   * 数据请求主通道：radar:// 代理（普通 fetch 语义，大负载可靠）
   * 兜底通道：webkit.messageHandlers（仅在代理不可用时使用）
   */
  async function fetchJson(url, opts = {}) {
    const timeout = Number(opts.timeout) || 25000;

    if (!hasNative) {
      // 浏览器调试：直连
      try {
        const res = await fetch(url);
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        return { ok: res.ok, status: res.status, ms: 0, bytes: text.length, data };
      } catch (err) {
        return { ok: false, error: String(err && err.message), ms: 0, bytes: 0, data: null };
      }
    }

    const started = performance.now();
    try {
      const res = await fetch('radar://fetch/?url=' + encodeURIComponent(url));
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        ms: Math.round(performance.now() - started),
        bytes: text.length,
        data,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), ms: 0, bytes: 0, data: null };
    }
  }

  function nativeCall(action, payload) {
    post('native', Object.assign({ action }, payload || {}));
  }

  FR.bridge = {
    available: hasNative,
    fetchJson,
    copy: (text) => nativeCall('copy', { text: String(text ?? '') }),
    openExternal: (url) => nativeCall('open', { url }),
    setFullscreen: () => nativeCall('fullscreen'),
    quit: () => nativeCall('quit'),
  };

  // 兼容旧代码里 window.flightRadar 的调用点
  window.flightRadar = {
    info: () => Promise.resolve({ native: hasNative }),
    fetchJson,
    fetchJsonBatch: (urls, opts) => Promise.all((urls || []).map((u) => fetchJson(u, opts))),
    setFullscreen: () => FR.bridge.setFullscreen(),
    copy: (t) => FR.bridge.copy(t),
    openExternal: (u) => FR.bridge.openExternal(u),
    quit: () => FR.bridge.quit(),
  };
})();
