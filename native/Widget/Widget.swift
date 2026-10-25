//
//  Widget.swift — Flight Radar 通知中心小组件（WidgetKit）
//  小：迷你 3D 地球（每 2 分钟转一格）+ 在空架数
//  中：地球 + 当前空域最繁忙机场
//  数据来自主程序写的 ~/Library/Application Support/FlightRadar/widget.json
//
import WidgetKit
import SwiftUI
import CoreGraphics
import ImageIO

// MARK: 数据

struct Snapshot {
    var updatedAt: Date = .distantPast
    var airborne = 0
    var homeName = "杭州"
    var homeLat = 30.27, homeLon = 120.15
    var airports: [(code: String, city: String, count: Int)] = []
    var planes: [(lat: Double, lon: Double, watched: Bool)] = []

    static func load() -> Snapshot {
        var s = Snapshot()
        let home: String = {
            if let pw = getpwuid(getuid()), let d = pw.pointee.pw_dir { return String(cString: d) }
            return NSHomeDirectory()
        }()
        let url = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/FlightRadar/widget.json")
        guard let data = try? Data(contentsOf: url),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return s }
        s.updatedAt = Date(timeIntervalSince1970: (j["updatedAt"] as? Double) ?? 0)
        s.airborne = (j["airborne"] as? Int) ?? 0
        s.homeName = (j["homeName"] as? String) ?? s.homeName
        s.homeLat = (j["homeLat"] as? Double) ?? s.homeLat
        s.homeLon = (j["homeLon"] as? Double) ?? s.homeLon
        for a in (j["airports"] as? [[String: Any]]) ?? [] {
            s.airports.append(((a["code"] as? String) ?? "", (a["city"] as? String) ?? "", (a["count"] as? Int) ?? 0))
        }
        for p in (j["planes"] as? [[Double]]) ?? [] where p.count >= 3 {
            s.planes.append((p[0], p[1], p[2] > 0))
        }
        return s
    }
}

// MARK: 陆地掩膜（256×128 等距圆柱）→ 采样点

enum Land {
    static let points: [(Double, Double)] = {
        guard let url = Bundle.main.url(forResource: "landmask", withExtension: "png"),
              let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return [] }
        let w = img.width, h = img.height
        var buf = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return [] }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        var out: [(Double, Double)] = []
        for y in stride(from: 0, to: h, by: 1) {
            for x in stride(from: 0, to: w, by: 1) where buf[y * w + x] > 127 {
                let lat = 90 - (Double(y) + 0.5) / Double(h) * 180
                let lon = (Double(x) + 0.5) / Double(w) * 360 - 180
                out.append((lat, lon))
            }
        }
        return out
    }()
}

// MARK: Timeline

struct Entry: TimelineEntry {
    let date: Date
    let snap: Snapshot
    let spin: Double     // 地球自转相位（度）
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), snap: Snapshot(), spin: 0) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), snap: Snapshot.load(), spin: 0))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let snap = Snapshot.load()
        let now = Date()
        // 小组件不能连续动画：预先生成 30 帧，每 2 分钟转 4°，一小时后再取新数据
        let entries = (0..<30).map { i in
            Entry(date: now.addingTimeInterval(Double(i) * 120), snap: snap, spin: Double(i) * 4)
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
    }
}

// MARK: 视图

struct GlobeView: View {
    let snap: Snapshot
    let spin: Double

    var body: some View {
        Canvas { ctx, size in
            let r = min(size.width, size.height) / 2 - 2
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let lat0 = max(-60, min(60, snap.homeLat)) * .pi / 180
            let lon0 = (snap.homeLon - 25 + spin) * .pi / 180

            func project(_ lat: Double, _ lon: Double) -> CGPoint? {
                let φ = lat * .pi / 180, λ = lon * .pi / 180 - lon0
                let cosc = sin(lat0) * sin(φ) + cos(lat0) * cos(φ) * cos(λ)
                guard cosc > 0 else { return nil }
                let x = cos(φ) * sin(λ)
                let y = cos(lat0) * sin(φ) - sin(lat0) * cos(φ) * cos(λ)
                return CGPoint(x: c.x + x * r, y: c.y - y * r)
            }

            let disc = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
            ctx.fill(disc, with: .radialGradient(Gradient(colors: [Color(red: 0.06, green: 0.20, blue: 0.38),
                                                                   Color(red: 0.01, green: 0.05, blue: 0.12)]),
                                                 center: CGPoint(x: c.x - r * 0.3, y: c.y - r * 0.3),
                                                 startRadius: 0, endRadius: r * 1.4))
            let dot = max(1.2, r / 70)
            var land = Path()
            for (la, lo) in Land.points {
                if let p = project(la, lo) { land.addRect(CGRect(x: p.x - dot / 2, y: p.y - dot / 2, width: dot, height: dot)) }
            }
            ctx.fill(land, with: .color(Color(red: 0.35, green: 0.62, blue: 0.55).opacity(0.85)))

            // 飞机：FR24 黄点，关注机型橙色
            var yp = Path(), op = Path()
            for p in snap.planes {
                guard let q = project(p.lat, p.lon) else { continue }
                let rr = p.watched ? 2.4 : 1.4
                let rect = CGRect(x: q.x - rr, y: q.y - rr, width: 2 * rr, height: 2 * rr)
                if p.watched { op.addEllipse(in: rect) } else { yp.addEllipse(in: rect) }
            }
            ctx.fill(yp, with: .color(Color(red: 1, green: 0.8, blue: 0)))
            ctx.fill(op, with: .color(Color(red: 1, green: 0.5, blue: 0.1)))

            if let h = project(snap.homeLat, snap.homeLon) {
                ctx.stroke(Path(ellipseIn: CGRect(x: h.x - 4, y: h.y - 4, width: 8, height: 8)), with: .color(.white), lineWidth: 1.2)
            }
            ctx.stroke(disc, with: .color(Color(red: 0.3, green: 0.72, blue: 1).opacity(0.55)), lineWidth: 1)
        }
    }
}

struct StaleNote: View {
    let snap: Snapshot
    var body: some View {
        if Date().timeIntervalSince(snap.updatedAt) > 1800 {
            Text("打开 Flight Radar 以更新").font(.system(size: 9)).foregroundStyle(.secondary)
        } else {
            Text(snap.updatedAt, style: .time).font(.system(size: 9)).foregroundStyle(.secondary)
        }
    }
}

struct RadarWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        let s = entry.snap
        Group {
            if family == .systemSmall {
                ZStack(alignment: .bottomLeading) {
                    GlobeView(snap: s, spin: entry.spin)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(s.airborne)").font(.system(size: 18, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        Text("架在空 · \(s.homeName)").font(.system(size: 9)).foregroundStyle(.white.opacity(0.75))
                    }
                }
            } else {
                HStack(spacing: 10) {
                    GlobeView(snap: s, spin: entry.spin).aspectRatio(1, contentMode: .fit)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("最繁忙机场").font(.system(size: 11, weight: .semibold))
                            Spacer()
                            Text("\(s.airborne) 架").font(.system(size: 10, weight: .medium)).foregroundStyle(Color(red: 1, green: 0.8, blue: 0))
                        }
                        if s.airports.isEmpty {
                            Text("暂无数据").font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                        ForEach(Array(s.airports.prefix(5).enumerated()), id: \.offset) { i, ap in
                            HStack(spacing: 4) {
                                Text("\(i + 1)").font(.system(size: 9, weight: .bold)).frame(width: 10)
                                Text(ap.city).font(.system(size: 10)).lineLimit(1)
                                Spacer(minLength: 2)
                                Text("\(ap.count)").font(.system(size: 10, weight: .semibold).monospacedDigit())
                            }
                        }
                        Spacer(minLength: 0)
                        StaleNote(snap: s)
                    }
                }
            }
        }
        .modifier(WidgetBackground())
    }
}

struct WidgetBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.containerBackground(for: .widget) { Color(red: 0.02, green: 0.04, blue: 0.08) }
        } else {
            content.padding(10).background(Color(red: 0.02, green: 0.04, blue: 0.08))
        }
    }
}

@main
struct FlightRadarWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlightRadarGlobe", provider: Provider()) { entry in
            RadarWidgetView(entry: entry)
        }
        .configurationDisplayName("Flight Radar")
        .description("迷你地球与当前空域最繁忙机场")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
