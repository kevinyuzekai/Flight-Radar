//
//  Feed.swift — 数据层：并行拉取 adsb.lol + adsb.fi，归一化，按 hex 取最新定位合并
//
import Foundation

enum Feed {
    /// 超过这个 seen_pos（秒）的定位视为过期，直接丢弃
    static let maxSeenPos = 60.0

    struct Result {
        var aircraft: [Aircraft]
        var counts: [String: Int]
        var errors: [String]
    }

    static func endpoints(center: LatLon, nm: Int) -> [(String, String)] {
        [("lol", "https://api.adsb.lol/v2/point/\(center.lat)/\(center.lon)/\(nm)"),
         ("fi", "https://opendata.adsb.fi/api/v2/lat/\(center.lat)/lon/\(center.lon)/dist/\(min(250, nm))")]
    }

    static func fetch(session: URLSession, center: LatLon, nm: Int, done: @escaping (Result) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var lists: [String: [Aircraft]] = [:]
        var errors: [String] = []
        for (name, u) in endpoints(center: center, nm: nm) {
            guard let url = URL(string: u) else { continue }
            var req = URLRequest(url: url)
            req.setValue("FlightRadar/2.0", forHTTPHeaderField: "User-Agent")
            group.enter()
            session.dataTask(with: req) { data, resp, err in
                defer { group.leave() }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                lock.lock(); defer { lock.unlock() }
                if let data, err == nil, code == 200 {
                    lists[name] = parse(data, source: name)
                } else {
                    errors.append("\(name): \(err?.localizedDescription ?? "HTTP \(code)")")
                }
            }.resume()
        }
        group.notify(queue: .global()) {
            var best: [String: Aircraft] = [:]
            for list in lists.values {
                for a in list where (best[a.hex]?.fixTime ?? -1) < a.fixTime { best[a.hex] = a }
            }
            done(Result(aircraft: Array(best.values), counts: lists.mapValues { $0.count }, errors: errors))
        }
    }

    private static func num(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    /// 归一化：只保留带 lat/lon 且 seen_pos ≤ 60s 的记录；位置原样取 API 的 lat/lon
    static func parse(_ data: Data, source: String) -> [Aircraft] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        let list = (root["ac"] as? [[String: Any]]) ?? (root["aircraft"] as? [[String: Any]]) ?? []
        let recv = Date().timeIntervalSince1970
        var snap = num(root["now"]).map { $0 > 1e11 ? $0 / 1000 : $0 } ?? recv
        if snap > recv + 5 || snap < recv - 600 { snap = recv }

        var out: [Aircraft] = []
        out.reserveCapacity(list.count)
        for a in list {
            guard let hex = (a["hex"] as? String)?.lowercased(),
                  let lat = num(a["lat"]), let lon = num(a["lon"]),
                  abs(lat) <= 90, abs(lon) <= 180 else { continue }
            let seenPos = num(a["seen_pos"]) ?? num(a["seen"]) ?? 0
            guard seenPos <= maxSeenPos else { continue }

            var alt = -1, onGround = false
            if (a["alt_baro"] as? String) == "ground" { onGround = true; alt = 0 }
            else if let n = num(a["alt_baro"]) ?? num(a["alt_geom"]) { alt = Int(n) }

            var ac = Aircraft(hex: hex,
                              callsign: (a["flight"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "",
                              type: (a["t"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "",
                              registration: (a["r"] as? String) ?? "",
                              lat: lat, lon: lon, altitudeFt: alt,
                              groundSpeedKt: Int(num(a["gs"]) ?? 0),
                              track: num(a["track"]) ?? num(a["true_heading"]) ?? 0,
                              verticalRate: Int(num(a["baro_rate"]) ?? 0),
                              onGround: onGround)
            ac.fixTime = snap - max(0, seenPos)
            ac.lastSeen = recv
            ac.source = source
            out.append(ac)
        }
        return out
    }
}
