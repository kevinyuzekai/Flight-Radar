//
//  Notifier.swift — 系统通知（拍机警报）
//
import Cocoa
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private(set) var authorized = false

    func setup(then: (() -> Void)? = nil) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] ok, err in
            DispatchQueue.main.async {
                self?.authorized = ok
                if !ok { NSLog("[Notifier] 未获授权: %@", err?.localizedDescription ?? "unknown") }
                then?()
            }
        }
    }

    /// 机型短名：A380 / 747 这类关注机型直接用常见叫法
    private func shortType(_ code: String) -> String {
        let t = code.uppercased()
        if t.hasPrefix("A38") { return "A380" }
        if t == "B748" { return "波音 747-8" }
        if t.hasPrefix("B74") { return "波音 747" }
        return Airlines.typeName(code)
    }

    func alert(_ aircraft: Aircraft, distKm: Double, home: String = "") {
        let airline = Airlines.name(for: aircraft.callsign) ?? ""
        let who = "一架\(airline)\(airline.isEmpty ? "" : " ")\(shortType(aircraft.type))"
        let place = distKm <= 5 ? "正从你家楼顶飞过" : "正从你家附近 \(Int(distKm.rounded())) 公里处飞过"
        let alt = aircraft.onGround ? "在地面" : "高度 \(aircraft.altitudeFt) 英尺"

        let content = UNMutableNotificationContent()
        content.title = "⚠️ 拍机警报"
        content.body = "⚠️ 警告：\(who)\(place)，\(alt)！"
        var sub = [aircraft.displayName]
        if !aircraft.registration.isEmpty { sub.append(aircraft.registration) }
        sub.append(String(format: "距%@ %.0f km", home.isEmpty ? "家" : home, distKm))
        content.subtitle = sub.joined(separator: " · ")
        content.sound = .default
        content.threadIdentifier = "spotting"
        post(id: "fr-\(aircraft.hex)", content)   // 同一架用同一 id：系统里只保留最新一条
    }

    /// 测试通知（设置页按钮 / --test-alert）
    func sendTest(home: String) {
        let a = Aircraft(hex: "test01", callsign: "UAE308", type: "A388", registration: "A6-EUA",
                         lat: 0, lon: 0, altitudeFt: 35000, groundSpeedKt: 480, track: 90,
                         verticalRate: 0, onGround: false)
        alert(a, distKm: 2, home: home)
    }

    private func post(id: String, _ content: UNNotificationContent) {
        let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { err in
            if let err { NSLog("[Notifier] add failed: %@", err.localizedDescription) }
            else { NSLog("[Notifier] posted %@", id) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
}
