//
//  Flight Radar — 原生外层（AppKit + WKWebView）
//
//  为什么不用 Electron：Electron 框架本身约 180 MB，是包体下限，无法压到 20 MB。
//  这里改用系统自带的 WKWebView 承载同一套 Cesium 渲染层，外壳只有几百 KB。
//
//  三个职责：
//    1. app:// 自定义协议 —— 把 app/ 目录当本地静态站点（Cesium 需要 worker/模块，
//       file:// 的 origin 为 null 会被内核拒绝，导致影像瓦片解不出来）
//    2. 网络代理         —— JS 侧 fetch 走原生 URLSession，绕开 CORS，且只放行 ADS-B 域名
//    3. 窗口 / 菜单 / 冒烟自检
//
import Cocoa
import WebKit

// MARK: - 常量

let APP_HOST = "local"
let APP_SCHEME = "app"
let PROXY_SCHEME = "radar"
let ALLOWED_HOSTS: Set<String> = ["api.adsb.lol", "opendata.adsb.fi", "api.adsb.fi"]

let MIME: [String: String] = [
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "mjs": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "gif": "image/gif",
    "ico": "image/x-icon",
    "gltf": "model/gltf+json",
    "glb": "model/gltf-binary",
    "bin": "application/octet-stream",
    "ktx2": "image/ktx2",
    "wasm": "application/wasm",
    "woff": "font/woff",
    "woff2": "font/woff2",
    "ttf": "font/ttf",
    "txt": "text/plain; charset=utf-8",
    "xml": "application/xml; charset=utf-8",
]

// MARK: - app:// 协议处理

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    /// 已被 WebKit 停止的任务，避免继续回调导致崩溃
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }

        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/renderer/index.html" }

        let target = root.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        // 目录穿越防护
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else {
            return send(task, status: 403, mime: "text/plain", body: Data("Forbidden".utf8))
        }

        let ext = target.pathExtension.lowercased()

        // 若存在预压缩的 .gz，且客户端接受 gzip，则直接送达（Cesium.js 5.8M → 1.7M）
        let acceptsGzip = (task.request.value(forHTTPHeaderField: "Accept-Encoding") ?? "").contains("gzip")
        if acceptsGzip, FileManager.default.fileExists(atPath: target.path + ".gz"),
           let gz = try? Data(contentsOf: URL(fileURLWithPath: target.path + ".gz")) {
            var headers = ["Content-Type": MIME[ext] ?? "application/octet-stream",
                           "Content-Encoding": "gzip",
                           "Cache-Control": "no-cache",
                           "Access-Control-Allow-Origin": "*"]
            headers["Content-Length"] = String(gz.count)
            guard let response = HTTPURLResponse(url: url, statusCode: 200,
                                                 httpVersion: "HTTP/1.1",
                                                 headerFields: headers) else { return }
            deliver(task, response: response, body: gz)
            return
        }

        guard let body = try? Data(contentsOf: target) else {
            return send(task, status: 404, mime: "text/plain", body: Data("Not found".utf8))
        }

        var headers = ["Content-Type": MIME[ext] ?? "application/octet-stream",
                       "Cache-Control": "no-cache",
                       "Access-Control-Allow-Origin": "*"]
        headers["Content-Length"] = String(body.count)
        guard let response = HTTPURLResponse(url: url, statusCode: 200,
                                             httpVersion: "HTTP/1.1",
                                             headerFields: headers) else { return }
        deliver(task, response: response, body: body)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped.contains(ObjectIdentifier(task))
    }

    private func deliver(_ task: WKURLSchemeTask, response: URLResponse, body: Data) {
        guard !isStopped(task) else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
        lock.lock(); stopped.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func send(_ task: WKURLSchemeTask, status: Int, mime: String, body: Data) {
        guard !isStopped(task), let url = task.request.url else { return }
        guard let response = HTTPURLResponse(url: url, statusCode: status,
                                             httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": mime]) else { return }
        deliver(task, response: response, body: body)
    }
}

// MARK: - 数据代理协议 radar://
//
//  页面用普通 fetch('radar://fetch/?url=<encoded>') 拿 ADS-B 数据。
//  由原生 URLSession 出网，因此完全绕开 CORS；只放行白名单域名。
//  相比把 6MB JSON 塞进 evaluateJavaScript 字符串，这条路径可靠得多。

final class ProxyHandler: NSObject, WKURLSchemeHandler {
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = comps.queryItems?.first(where: { $0.name == "url" })?.value,
              let target = URL(string: raw), let host = target.host else {
            respond(task, status: 400, body: Data("bad request".utf8))
            return
        }
        guard ALLOWED_HOSTS.contains(host) else {
            respond(task, status: 403, body: Data("host not allowed".utf8))
            return
        }

        var request = URLRequest(url: target)
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("FlightRadar/1.0 (Mac)", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            if let error {
                self.respond(task, status: 502, body: Data(error.localizedDescription.utf8))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            self.respond(task, status: status, body: data ?? Data())
        }.resume()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped.contains(ObjectIdentifier(task))
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, body: Data) {
        guard !isStopped(task), let url = task.request.url else { return }
        let headers = [
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Content-Length": String(body.count),
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status,
                                             httpVersion: "HTTP/1.1",
                                             headerFields: headers) else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
        lock.lock(); stopped.remove(ObjectIdentifier(task)); lock.unlock()
    }
}

// MARK: - 网络代理 + 原生能力

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch message.name {
        case "fetch": handleFetch(body)
        case "native": handleNative(body)
        default: break
        }
    }

    /// 在页面里回调
    private func call(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func handleFetch(_ body: [String: Any]) {
        guard let id = body["id"] as? String, let urlStr = body["url"] as? String,
              let url = URL(string: urlStr), let host = url.host else {
            return
        }
        guard ALLOWED_HOSTS.contains(host) else {
            call("window.__nativeFetchFail(\(jsStr(id)),'host-not-allowed')")
            return
        }

        let timeout = (body["timeout"] as? Double) ?? 25
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("FlightRadar/1.0 (Mac)", forHTTPHeaderField: "User-Agent")

        let started = Date()
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            guard let self else { return }
            if let error {
                self.call("window.__nativeFetchFail(\(jsStr(id)),\(jsStr(error.localizedDescription)))")
                return
            }
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            // 文本经 JSON 编码后作为字符串字面量传入，避免转义问题
            let payload = jsStr(text)
            self.call("window.__nativeFetchDone(\(jsStr(id)),\(status),\(ms),\(payload))")
        }.resume()
    }

    private func handleNative(_ body: [String: Any]) {
        guard let action = body["action"] as? String else { return }
        switch action {
        case "copy":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(body["text"] as? String ?? "", forType: .string)
        case "open":
            if let s = body["url"] as? String, let u = URL(string: s),
               u.scheme == "https" || u.scheme == "http" {
                NSWorkspace.shared.open(u)
            }
        case "fullscreen":
            NSApp.keyWindow?.toggleFullScreen(nil)
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}

/// 把 Swift 字符串安全地嵌进 JS 字面量
func jsStr(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
    guard let data, let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
    // ["xxx"] -> "xxx"
    let start = arr.index(arr.startIndex, offsetBy: 1)
    let end = arr.index(arr.endIndex, offsetBy: -1)
    return String(arr[start..<end])
}

// MARK: - 窗口

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let bridge = Bridge()
    var smoke = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        smoke = CommandLine.arguments.contains("--smoke-test")

        let resURL = Bundle.main.resourceURL!
        let appDir = resURL.appendingPathComponent("app")

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(root: appDir), forURLScheme: APP_SCHEME)
        config.setURLSchemeHandler(ProxyHandler(), forURLScheme: PROXY_SCHEME)
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "fetch")
        ucc.add(bridge, name: "native")
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let rect = NSRect(x: 0, y: 0, width: 1500, height: 940)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Flight Radar"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(srgbRed: 0.016, green: 0.027, blue: 0.047, alpha: 1)
        window.minSize = NSSize(width: 1080, height: 700)
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.delegate = self
        window.center()

        webView = WKWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        bridge.webView = webView
        window.contentView = webView

        buildMenu()

        let url = URL(string: "\(APP_SCHEME)://\(APP_HOST)/renderer/index.html")!
        webView.load(URLRequest(url: url))

        // 无论是否自检都要显示窗口：WKWebView 在不可见时不会渲染，
        // 会导致帧循环停摆（fps=0）、遮挡剔除不执行、takeSnapshot 只能取到首帧。
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if smoke {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.runSmoke() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: 菜单

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 Flight Radar", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Flight Radar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Flight Radar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        viewItem.submenu = viewMenu
        let reloadItem = NSMenuItem(title: "重新加载", action: #selector(reload), keyEquivalent: "r")
        reloadItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(reloadItem)

        let fullItem = NSMenuItem(title: "切换全屏", action: #selector(toggleFull), keyEquivalent: "f")
        fullItem.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullItem)

        let dataItem = NSMenuItem()
        main.addItem(dataItem)
        let dataMenu = NSMenu(title: "数据来源")
        dataItem.submenu = dataMenu
        dataMenu.addItem(withTitle: "adsb.lol 官网", action: #selector(openLol), keyEquivalent: "")
        dataMenu.addItem(withTitle: "adsb.fi 官网", action: #selector(openFi), keyEquivalent: "")

        NSApp.mainMenu = main
    }

    @objc func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Flight Radar",
            .credits: NSAttributedString(string: "实时航班数据：adsb.lol · adsb.fi\n卫星影像：Esri World Imagery"),
        ])
    }

    @objc func reload() { webView.reload() }
    @objc func toggleFull() { window.toggleFullScreen(nil) }
    @objc func openLol() { NSWorkspace.shared.open(URL(string: "https://adsb.lol/")!) }
    @objc func openFi() { NSWorkspace.shared.open(URL(string: "https://adsb.fi/")!) }

    // MARK: 冒烟自检

    func runSmoke() {
        let outDir = FileManager.default.temporaryDirectory.appendingPathComponent("flight-radar-smoke")
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

        pollState(deadline: Date().addingTimeInterval(40)) { [weak self] state in
            guard let self else { return }
            print("[smoke] 状态: \(state)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                self.runChecks { extra in
                    print("[smoke] 自检: \(extra)")
                    self.snapshot(to: outDir) {
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    /// 轮询 window.__FR_STATE__ 直到数据源成功或超时
    func pollState(deadline: Date, done: @escaping (String) -> Void) {
        let js = "JSON.stringify(window.__FR_STATE__||{})"
        webView.evaluateJavaScript(js) { result, _ in
            let s = (result as? String) ?? "{}"
            let ok = s.contains("\"lastOk\":true")
            if ok || Date() > deadline {
                done(s)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.pollState(deadline: deadline, done: done)
                }
            }
        }
    }

    /// 图标分型 + 遮挡剔除 + 交互检查
    func runChecks(_ done: @escaping (String) -> Void) {
        let js = """
        (() => {
          const out = { classes: {}, images: [], depth: null, interact: {}, diag: {} };
          out.diag.loadingClass = document.querySelector('#loading') ? document.querySelector('#loading').className : 'none';
          out.diag.ready = FR.state.ready;
          out.diag.viewer = !!(FR.scene && FR.scene.state && FR.scene.state.viewer);
          out.diag.cesium = typeof window.Cesium;
          out.diag.bridge = !!(FR.bridge && FR.bridge.available);
          out.diag.errors = FR.state.errors.slice(-6);
          try {
            const c = document.createElement('canvas');
            out.diag.webgl2 = !!c.getContext('webgl2');
            out.diag.webgl1 = !!c.getContext('webgl');
          } catch (e) { out.diag.webglErr = String(e); }
          out.diag.sources = FR.state.sources;
          for (const p of FR.sources.planes) {
            const c = FR.scene.classify(p);
            out.classes[c] = (out.classes[c] || 0) + 1;
          }
          const seen = new Set();
          for (const e of FR.scene.planeIndex.values()) {
            const img = e.bb.image;
            const k = typeof img === 'string' ? img.split('/').pop() : (img && img.src ? img.src.split('/').pop() : null);
            if (k) seen.add(k);
          }
          out.images = [...seen].sort();
          out.depth = FR.scene.debugDepth();
          const ps = FR.sources.planes;
          const t = ps.find(p => p.callsign && p.callsign.length > 3);
          if (t) {
            const inp = document.querySelector('#search-input');
            inp.value = t.callsign;
            inp.dispatchEvent(new Event('input'));
            FR.scene.select(t.hex);
            out.interact.searchTarget = t.callsign;
            out.interact.detailOpen = !document.querySelector('#detail').classList.contains('hidden');
            out.interact.detailCallsign = document.querySelector('#d-callsign').textContent;
            FR.scene.follow(t.hex);
            out.interact.followHex = FR.scene.followHex;
            FR.scene.unfollow();
            FR.scene.flyTo('europe');
          }
          return JSON.stringify(out);
        })()
        """
        webView.evaluateJavaScript(js) { result, error in
            if let error { done("error: \(error.localizedDescription)") }
            else { done((result as? String) ?? "null") }
        }
    }

    func snapshot(to dir: URL, done: @escaping () -> Void) {
        let cfg = WKSnapshotConfiguration()
        cfg.afterScreenUpdates = true
        webView.takeSnapshot(with: cfg) { image, _ in
            if let image, let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                let file = dir.appendingPathComponent("screenshot.png")
                try? png.write(to: file)
                print("[smoke] 截图: \(file.path)")
            }
            done()
        }
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
