//
//  WidgetBridge.swift — 把雷达快照写给通知中心小组件
//  小组件是沙盒扩展，通过 entitlement 只读访问 ~/Library/Application Support/FlightRadar/
//
import Foundation
import WidgetKit

enum WidgetBridge {
    private static var lastReload = Date.distantPast

    static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FlightRadar/widget.json")
    }

    static func write(store: RadarStore) {
        let s = store.settings
        let near = store.nearby(limit: 400)
        let planes: [[Double]] = near.compactMap { (a, _) in
            a.isAirborne ? [round(a.lat * 100) / 100, round(a.lon * 100) / 100, s.isWatched(a) ? 1 : 0] : nil
        }
        let top: [[String: Any]] = near.filter { $0.0.isAirborne }.prefix(4).map { (a, d) in
            ["cs": a.displayName, "type": a.type, "alt": a.altitudeFt, "km": round(d * 10) / 10]
        }
        let aps: [[String: Any]] = store.busiestAirports(limit: 5).map {
            ["code": $0.code, "city": $0.city, "count": $0.count]
        }
        let payload: [String: Any] = [
            "updatedAt": Date().timeIntervalSince1970,
            "airborne": store.countAirborne(),
            "homeName": s.homeName, "homeLat": s.homeLat, "homeLon": s.homeLon,
            "airports": aps, "planes": planes, "nearby": top,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)

        // 系统对刷新有配额，这里最多 2 分钟请求一次重载
        if Date().timeIntervalSince(lastReload) > 120 {
            lastReload = Date()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
