//
//  Panel.swift — 无边框半透明悬浮窗 + 菜单栏
//
import Cocoa
import WebKit

/// 无边框、半透明、可拖动的浮动面板
final class PanelWindow: NSWindow {
    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.borderless, .fullSizeContentView],
                   backing: .buffered, defer: false)
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = true
        self.level = .floating
        self.isMovableByWindowBackground = false
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.titlebarAppearsTransparent = true
        self.titleVisibility = .hidden
        self.hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { true }
}

/// 面板 + 网页 + 覆盖层
final class PanelController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let window: PanelWindow
    let webView: WKWebView
    private weak var store: RadarStore?

    private let size = NSSize(width: 330, height: 560)

    init(store: RadarStore, schemeHandler: WKURLSchemeHandler) {
        self.store = store

        window = PanelWindow(size: size)

        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(schemeHandler, forURLScheme: "app")
        cfg.setURLSchemeHandler(ProxySchemeHandler(), forURLScheme: "radar")
        let ucc = WKUserContentController()
        cfg.userContentController = ucc

        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: cfg)

        super.init()

        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self
        ucc.add(self, name: "radar")
        // 1.0.0 共用的 bridge.js 以此判断原生环境，数据走 radar:// 代理
        ucc.add(self, name: "fetch")

        // 圆角：给内容视图加遮罩
        let host = NSView(frame: NSRect(origin: .zero, size: size))
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        host.addSubview(webView)
        window.contentView = host

        let url = URL(string: "app://local/ui/index.html")!
        webView.load(URLRequest(url: url))
    }

    // MARK: 显示 / 隐藏

    func toggle(relativeTo button: NSStatusBarButton?) {
        if window.isVisible {
            hide()
        } else {
            show(relativeTo: button)
        }
    }

    func show(relativeTo button: NSStatusBarButton?) {
        guard let screen = NSScreen.main else { return }
        var x: CGFloat
        var y: CGFloat

        if let button, let win = button.window {
            let r = win.convertToScreen(button.convert(button.bounds, to: nil))
            x = r.midX - size.width / 2
            y = r.minY - size.height - 8
        } else {
            x = screen.visibleFrame.maxX - size.width - 18
            y = screen.visibleFrame.maxY - size.height - 18
        }

        // 别超出屏幕
        x = max(screen.visibleFrame.minX + 8, min(x, screen.visibleFrame.maxX - size.width - 8))
        y = max(screen.visibleFrame.minY + 8, y)

        window.setFrameOrigin(NSPoint(x: x, y: y))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        pushData()
        pushSettings()
    }

    func hide() {
        window.orderOut(nil)
    }

    // MARK: 数据推送

    func pushData() {
        guard let store else { return }
        let center = store.settings.home
        let nearby = store.nearby(limit: 800)

        let planes: [[String: Any]] = nearby.map { (a, d) in
            let cls = AircraftClass.classify(a.type)
            let bearing = Geo.bearing(from: center, to: a.position)
            return [
                "hex": a.hex,
                "callsign": a.displayName,
                "type": a.type,
                "typeName": Airlines.typeName(a.type),
                "airline": Airlines.name(for: a.callsign) ?? "",
                "reg": a.registration,
                "lat": a.lat,
                "lon": a.lon,
                "altFt": a.altitudeFt,
                "gs": a.groundSpeedKt,
                "track": a.track,
                "onGround": a.onGround,
                "fixT": a.fixTime,
                "vs": a.verticalRate,
                "source": a.source,
                "cls": cls.rawValue,
                "watched": store.settings.isWatched(a),
                "distKm": d,
                "dirText": compass(bearing),
            ]
        }

        var airportRows: [[String: Any]] = []
        for ap in store.busiestAirports(limit: 6) {
            airportRows.append(["code": ap.code, "city": ap.city, "count": ap.count])
        }

        let payload: [String: Any] = [
            "ok": store.lastError == nil,
            "error": store.lastError ?? "",
            "airborne": store.countAirborne(),
            "homeName": store.settings.homeName,
            "radiusKm": store.settings.radiusKm,
            "homeLat": center.lat, "homeLon": center.lon,
            "nowT": Date().timeIntervalSince1970,
            "sources": store.sourceCounts,
            "planes": planes,
            "airports": airportRows,
            "updatedAt": store.updatedAt.map { Int($0.timeIntervalSince1970) } ?? 0,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }

        let js = "window.renderRadar(\(json));"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func pushSettings() {
        guard let store else { return }
        let s = store.settings
        let payload: [String: Any] = [
            "homeLat": s.homeLat,
            "homeLon": s.homeLon,
            "homeName": s.homeName,
            "radiusKm": s.radiusKm,
            "feedRadiusNm": s.feedRadiusNm,
            "alertEnabled": s.alertEnabled,
            "watches": s.watches,
            "watchTypes": (s.watchTypes ?? []).joined(separator: " "),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("window.renderSettings(\(json));", completionHandler: nil)
        }
    }

    func showAlertToast(_ text: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let arr = String(data: data, encoding: .utf8) else { return }
        let inner = String(arr.dropFirst().dropLast())
        webView.evaluateJavaScript("window.notifyAlert(\(inner));", completionHandler: nil)
    }

    private func compass(_ deg: Double) -> String {
        let dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
        let i = Int((deg / 45).rounded()) % 8
        return dirs[(i + 8) % 8]
    }

    // MARK: 页面消息

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "radar" else { return }
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String, let store else { return }

        switch action {
        case "ready":
            pushData()
            pushSettings()

        case "seek", "focus":
            break

        case "testAlert":
            Notifier.shared.sendTest(home: store.settings.homeName)

        case "toggleAlert":
            store.settings.alertEnabled = (body["enabled"] as? Bool) ?? true
            store.saveSettings()
            pushSettings()

        case "getSettings":
            pushSettings()

        case "saveSettings":
            guard let s = body["settings"] as? [String: Any] else { return }
            if let v = s["homeLat"] as? Double { store.settings.homeLat = v }
            if let v = s["homeLon"] as? Double { store.settings.homeLon = v }
            if let v = s["homeName"] as? String { store.settings.homeName = v }
            if let v = s["radiusKm"] as? Double { store.settings.radiusKm = v }
            if let v = s["feedRadiusNm"] as? Int { store.settings.feedRadiusNm = v }
            if let v = s["alertEnabled"] as? Bool { store.settings.alertEnabled = v }
            if let w = s["watches"] as? [String: Bool] { store.settings.watches = w }
            if let t = s["watchTypes"] as? String {
                store.settings.watchTypes = t.uppercased()
                    .components(separatedBy: CharacterSet(charactersIn: " ,，;；\n"))
                    .filter { !$0.isEmpty }
            }
            store.saveSettings()
            store.tick()
            pushSettings()

        case "quit":
            NSApp.terminate(nil)

        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushData()
        pushSettings()
    }
}
