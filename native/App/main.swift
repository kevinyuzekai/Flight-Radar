//
//  main.swift — 菜单栏常驻应用
//
//  形态：
//    · 菜单栏图标显示「全球在空飞机数」
//    · 点图标弹出无边框半透明悬浮窗（迷你 3D 地球 / 机场榜 / 头顶飞机）
//    · 「拍机警报」用系统通知推送到右上角
//
import Cocoa
import WebKit

// MARK: - 菜单栏图标（代码绘制，避免依赖图片资源）

func makeStatusIcon(count: Int) -> NSImage {
    let w: CGFloat = 30, h: CGFloat = 18
    let img = NSImage(size: NSSize(width: w, height: h))
    img.lockFocus()

    // 飞机剪影
    let plane = NSBezierPath()
    plane.move(to: NSPoint(x: 15, y: 15))
    plane.line(to: NSPoint(x: 16.6, y: 11))
    plane.line(to: NSPoint(x: 16.6, y: 7.4))
    plane.line(to: NSPoint(x: 22, y: 5.2))
    plane.line(to: NSPoint(x: 22, y: 3.9))
    plane.line(to: NSPoint(x: 16.6, y: 5.5))
    plane.line(to: NSPoint(x: 16.6, y: 2.6))
    plane.line(to: NSPoint(x: 18, y: 1.2))
    plane.line(to: NSPoint(x: 18, y: 0.3))
    plane.line(to: NSPoint(x: 15, y: 1.4))
    plane.line(to: NSPoint(x: 12, y: 0.3))
    plane.line(to: NSPoint(x: 12, y: 1.2))
    plane.line(to: NSPoint(x: 13.4, y: 2.6))
    plane.line(to: NSPoint(x: 13.4, y: 5.5))
    plane.line(to: NSPoint(x: 8, y: 3.9))
    plane.line(to: NSPoint(x: 8, y: 5.2))
    plane.line(to: NSPoint(x: 13.4, y: 7.4))
    plane.line(to: NSPoint(x: 13.4, y: 11))
    plane.close()
    NSColor.black.setFill()
    plane.fill()

    // 数字
    let text = count >= 1000 ? "\(count / 1000)k" : "\(count)"
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
        .foregroundColor: NSColor.black,
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let sz = str.size()
    str.draw(at: NSPoint(x: w - sz.width, y: (h - sz.height) / 2 + 3))

    img.unlockFocus()
    img.isTemplate = true
    return img
}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: PanelController!
    private let store = RadarStore.shared
    private var refreshTimer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let resRoot = Bundle.main.resourceURL!.appendingPathComponent("app")

        panel = PanelController(store: store, schemeHandler: AppSchemeHandler(root: resRoot))

        // 菜单栏
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = makeStatusIcon(count: 0)
            button.imagePosition = .imageLeft
            button.target = self
            button.action = #selector(togglePanel)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // 通知
        Notifier.shared.setup { [weak self] in
            if CommandLine.arguments.contains("--test-alert") {
                Notifier.shared.sendTest(home: self?.store.settings.homeName ?? "")
            }
        }

        // 数据回调
        store.onUpdate = { [weak self] in
            guard let self else { return }
            let n = self.store.countAirborne()
            if let button = self.statusItem.button {
                button.image = makeStatusIcon(count: n)
                button.toolTip = "Flight Radar · \(n) 架在空"
            }
            self.panel.pushData()
        }

        store.onAlert = { [weak self] aircraft, dist in
            Notifier.shared.alert(aircraft, distKm: dist, home: self?.store.settings.homeName ?? "")
            self?.panel.showAlertToast("⚠️ \(aircraft.displayName) 进入 \(Int(dist))km")
            if let self, !self.panel.window.isVisible {
                self.panel.show(relativeTo: nil)
            }
        }

        store.start()

        // 自检模式：--self-test 时自动开面板、抓状态、截图后退出
        if CommandLine.arguments.contains("--self-test") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.runSelfTest() }
        }

        // 每 5 秒刷新菜单栏数字
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, let button = self.statusItem.button else { return }
            button.image = makeStatusIcon(count: self.store.countAirborne())
        }
    }

    // MARK: 自检

    private func runSelfTest() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("flight-radar-selftest")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        panel.show(relativeTo: statusItem.button)
        print("[selftest] panel visible=\(panel.window.isVisible) size=\(panel.window.frame.size)")

        // 等数据 + 渲染
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in
            guard let self else { return }
            self.panel.webView.evaluateJavaScript(
                "JSON.stringify({ready: !!window.__FR_READY__, sprites: (document.querySelector('#globe')||{}).width, count: document.querySelector('#globalCount').textContent, nearby: document.querySelector('#nearbyCount').textContent, planes: document.querySelectorAll('.plane').length, err: window.__FR_ERR__ || null})"
            ) { res, err in
                print("[selftest] page=\(res ?? "nil") err=\(err?.localizedDescription ?? "none")")
                self.panel.webView.evaluateJavaScript("window.__frDebug(6)") { r, _ in print("[selftest] plotted=\(r ?? "nil")"); fflush(stdout) }

                self.snapshot(self.panel.window) { img in
                    if let img, let tiff = img.tiffRepresentation,
                       let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        let f = dir.appendingPathComponent("panel.png")
                        try? png.write(to: f)
                        print("[selftest] 截图: \(f.path)")
                    }
                    self.snapshotScreen(to: dir)
                }
            }
        }
    }

    private func snapshot(_ window: NSWindow, done: @escaping (NSImage?) -> Void) {
        guard let view = window.contentView else { done(nil); return }
        let bounds = view.bounds
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { done(nil); return }
        view.cacheDisplay(in: bounds, to: rep)
        let img = NSImage(size: bounds.size)
        img.addRepresentation(rep)
        done(img)
    }

    private func snapshotScreen(to dir: URL) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", dir.appendingPathComponent("screen.png").path]
        try? task.run()
        task.waitUntilExit()
        print("[selftest] 全屏截图完成")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSApp.terminate(nil)
        }
    }

    @objc private func togglePanel(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp {
            showContextMenu()
            return
        }
        panel.toggle(relativeTo: sender)
    }

    private func showContextMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "显示面板", action: #selector(showPanel), keyEquivalent: "").target = self
        menu.addItem(.separator())
        let alertItem = NSMenuItem(title: "拍机警报", action: #selector(toggleAlert), keyEquivalent: "")
        alertItem.state = store.settings.alertEnabled ? .on : .off
        alertItem.target = self
        menu.addItem(alertItem)
        menu.addItem(withTitle: "发送测试通知", action: #selector(testAlert), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Flight Radar", action: #selector(quit), keyEquivalent: "q").target = self

        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func showPanel() { panel.show(relativeTo: statusItem.button) }

    @objc private func toggleAlert() {
        store.settings.alertEnabled.toggle()
        store.saveSettings()
    }

    @objc private func testAlert() { Notifier.shared.sendTest(home: store.settings.homeName) }

    @objc private func quit() { NSApp.terminate(nil) }
}

@main
struct FlightRadarApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
