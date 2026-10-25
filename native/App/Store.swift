//
//  Store.swift — 数据拉取、解析、本地订阅判定、位置
//
import Foundation
import CoreLocation

// MARK: - 设置

struct Settings: Codable {
    var homeLat: Double = 30.2741
    var homeLon: Double = 120.1551
    var homeName: String = "杭州"
    var radiusKm: Double = 30
    var watches: [String: Bool] = ["a380": true, "b747": true]   // cls.rawValue -> on
    var alertAboveFt: Int = 0                                     // 0 = 不限高度
    var alertEnabled: Bool = true
    var feedRadiusNm: Int = 250                                   // 拉取半径（NM）
    /// 额外关注的机型代码（如 B77W、A35K），可选字段以兼容旧设置文件
    var watchTypes: [String]? = nil

    var home: LatLon { LatLon(lat: homeLat, lon: homeLon) }

    func isWatched(_ cls: AircraftClass) -> Bool {
        watches[cls.rawValue] ?? false
    }

    /// 某架飞机是否在关注列表（机型大类 或 额外机型代码前缀）
    func isWatched(_ a: Aircraft) -> Bool {
        if isWatched(AircraftClass.classify(a.type)) { return true }
        let t = a.type.uppercased()
        guard !t.isEmpty else { return false }
        return (watchTypes ?? []).contains { !$0.isEmpty && t.hasPrefix($0.uppercased()) }
    }
}

// MARK: - 主数据仓库

final class RadarStore {
    static let shared = RadarStore()

    private(set) var aircraft: [Aircraft] = []
    private(set) var updatedAt: Date?
    private(set) var lastError: String?
    private(set) var sourceCounts: [String: Int] = [:]

    var settings = Settings()

    /// 位置更新后回调（用于刷新面板与菜单）
    var onUpdate: (() -> Void)?
    var onAlert: ((Aircraft, Double) -> Void)?

    private let session: URLSession
    private var timer: Timer?
    private var inFlight = false
    private let lock = NSLock()

    /// 已提醒过的架次，避免同机重复弹窗（hex → 时间）
    private var alerted: [String: Date] = [:]

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 25
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
        loadSettings()
    }

    // MARK: 设置持久化

    private var settingsURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FlightRadar", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("settings.json")
    }

    func loadSettings() {
        guard let data = try? Data(contentsOf: settingsURL),
              let s = try? JSONDecoder().decode(Settings.self, from: data) else { return }
        settings = s
    }

    func saveSettings() {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        try? data.write(to: settingsURL)
    }

    // MARK: 轮询

    func start() {
        stop()
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func tick() {
        lock.lock()
        if inFlight { lock.unlock(); return }
        inFlight = true
        lock.unlock()

        let center = settings.home
        // 以家为中心拉取，半径可调（100/250/450 NM）
        let nm = max(50, min(600, settings.feedRadiusNm))
        Feed.fetch(session: session, center: center, nm: nm) { [weak self] res in
            guard let self else { return }
            defer { self.lock.lock(); self.inFlight = false; self.lock.unlock() }
            if res.aircraft.isEmpty && !res.errors.isEmpty {
                self.lastError = res.errors.joined(separator: "; ")
                DispatchQueue.main.async { self.onUpdate?() }
                return
            }
            let fresh = res.aircraft
            self.sourceCounts = res.counts
            if CommandLine.arguments.contains("--dump-feed") {
                for a in fresh.sorted(by: { $0.hex < $1.hex }) {
                    print(String(format: "[feed] %@ %@ %.6f %.6f fix=%.1f", a.hex, a.source, a.lat, a.lon, a.fixTime))
                }
                print("[feed] counts \(res.counts) merged=\(fresh.count) errors=\(res.errors)"); fflush(stdout)
            }
            self.lock.lock()
            // 合并：只接受更新的定位，旧/相同时刻的不覆盖；本轮缺席的飞机保留 60 秒
            let nowT = Date().timeIntervalSince1970
            var map: [String: Aircraft] = [:]
            for a in self.aircraft where nowT - a.lastSeen < 60 { map[a.hex] = a }
            for a in fresh {
                if let old = map[a.hex], old.fixTime >= a.fixTime {
                    var keep = old; keep.lastSeen = a.lastSeen; map[a.hex] = keep
                } else {
                    map[a.hex] = a
                }
            }
            let parsed = Array(map.values)
            self.aircraft = parsed
            self.updatedAt = Date()
            self.lastError = nil
            self.lock.unlock()

            // 本地半径内的飞机
            let nearby = fresh.filter { Geo.distanceKm($0.position, center) <= 120 }

            DispatchQueue.main.async {
                WidgetBridge.write(store: self)
                self.onUpdate?()
                self.evaluateAlerts(nearby)
            }
        }
    }

    // MARK: 拍机警报

    private func evaluateAlerts(_ nearby: [Aircraft]) {
        guard settings.alertEnabled else { return }
        let center = settings.home
        let now = Date()

        for a in nearby {
            guard a.isAirborne else { continue }
            guard settings.isWatched(a) else { continue }
            if settings.alertAboveFt > 0, a.altitudeFt < settings.alertAboveFt { continue }

            let dist = Geo.distanceKm(a.position, center)
            guard dist <= settings.radiusKm else { continue }

            // 同一架 30 分钟内只提醒一次
            if let last = alerted[a.hex], now.timeIntervalSince(last) < 1800 { continue }
            alerted[a.hex] = now
            onAlert?(a, dist)
        }

        // 清理过期的记录
        alerted = alerted.filter { now.timeIntervalSince($0.value) < 3600 }
    }

    // MARK: 查询

    /// 按距离排序的附近飞机
    func nearby(limit: Int = 40) -> [(Aircraft, Double)] {
        let center = settings.home
        lock.lock()
        let list = aircraft
        lock.unlock()
        return list
            .map { ($0, Geo.distanceKm($0.position, center)) }
            .sorted { $0.1 < $1.1 }
            .prefix(limit)
            .map { $0 }
    }

    func countAirborne() -> Int {
        lock.lock(); defer { lock.unlock() }
        return aircraft.filter { $0.isAirborne }.count
    }

    /// 最繁忙机场（用周边 55km 内的在空飞机数近似）
    func busiestAirports(limit: Int = 6) -> [(code: String, city: String, count: Int)] {
        lock.lock()
        let list = aircraft
        lock.unlock()

        var counts: [String: Int] = [:]
        for a in list where a.isAirborne {
            for ap in Airports.all where Geo.distanceKm(a.position, ap.pos) <= 55 {
                counts[ap.code, default: 0] += 1
            }
        }

        var out: [(code: String, city: String, count: Int)] = []
        for (code, n) in counts {
            if let ap = Airports.all.first(where: { $0.code == code }) {
                out.append((ap.code, ap.city, n))
            }
        }
        out.sort { $0.count > $1.count }
        return Array(out.prefix(limit))
    }
}

// MARK: - 机场（用于最繁忙列表）

struct Airport {
    let code: String
    let city: String
    let pos: LatLon
}

enum Airports {
    static let all: [Airport] = [
        Airport(code: "ZSPD", city: "上海浦东", pos: LatLon(lat: 31.14, lon: 121.80)),
        Airport(code: "ZSSS", city: "上海虹桥", pos: LatLon(lat: 31.20, lon: 121.34)),
        Airport(code: "ZBAA", city: "北京首都", pos: LatLon(lat: 40.08, lon: 116.58)),
        Airport(code: "ZBAD", city: "北京大兴", pos: LatLon(lat: 39.51, lon: 116.41)),
        Airport(code: "ZGGG", city: "广州白云", pos: LatLon(lat: 23.39, lon: 113.30)),
        Airport(code: "ZGSZ", city: "深圳宝安", pos: LatLon(lat: 22.64, lon: 113.81)),
        Airport(code: "ZUUU", city: "成都双流", pos: LatLon(lat: 30.58, lon: 103.95)),
        Airport(code: "ZSHC", city: "杭州萧山", pos: LatLon(lat: 30.23, lon: 120.43)),
        Airport(code: "ZSNJ", city: "南京禄口", pos: LatLon(lat: 31.74, lon: 118.86)),
        Airport(code: "ZHHH", city: "武汉天河", pos: LatLon(lat: 30.78, lon: 114.21)),
        Airport(code: "ZUCK", city: "重庆江北", pos: LatLon(lat: 29.72, lon: 106.64)),
        Airport(code: "ZLXY", city: "西安咸阳", pos: LatLon(lat: 34.45, lon: 108.75)),
        Airport(code: "ZPPP", city: "昆明长水", pos: LatLon(lat: 25.10, lon: 102.93)),
        Airport(code: "ZUTF", city: "成都天府", pos: LatLon(lat: 30.31, lon: 104.44)),
        Airport(code: "RJTT", city: "东京羽田", pos: LatLon(lat: 35.55, lon: 139.78)),
        Airport(code: "RJAA", city: "东京成田", pos: LatLon(lat: 35.76, lon: 140.39)),
        Airport(code: "RKSI", city: "首尔仁川", pos: LatLon(lat: 37.46, lon: 126.44)),
        Airport(code: "VHHH", city: "香港赤鱲角", pos: LatLon(lat: 22.31, lon: 113.91)),
        Airport(code: "RCTP", city: "台北桃园", pos: LatLon(lat: 25.08, lon: 121.23)),
        Airport(code: "WSSS", city: "新加坡樟宜", pos: LatLon(lat: 1.36, lon: 103.99)),
        Airport(code: "VTBS", city: "曼谷素万那普", pos: LatLon(lat: 13.69, lon: 100.75)),
        Airport(code: "VIDP", city: "德里英迪拉", pos: LatLon(lat: 28.56, lon: 77.10)),
        Airport(code: "OMDB", city: "迪拜", pos: LatLon(lat: 25.25, lon: 55.36)),
        Airport(code: "LHR", city: "伦敦希思罗", pos: LatLon(lat: 51.47, lon: -0.45)),
        Airport(code: "CDG", city: "巴黎戴高乐", pos: LatLon(lat: 49.01, lon: 2.55)),
        Airport(code: "FRA", city: "法兰克福", pos: LatLon(lat: 50.03, lon: 8.57)),
        Airport(code: "AMS", city: "阿姆斯特丹", pos: LatLon(lat: 52.31, lon: 4.76)),
        Airport(code: "IST", city: "伊斯坦布尔", pos: LatLon(lat: 41.26, lon: 28.74)),
        Airport(code: "JFK", city: "纽约肯尼迪", pos: LatLon(lat: 40.64, lon: -73.78)),
        Airport(code: "LAX", city: "洛杉矶", pos: LatLon(lat: 33.94, lon: -118.41)),
        Airport(code: "ORD", city: "芝加哥", pos: LatLon(lat: 41.98, lon: -87.90)),
        Airport(code: "ATL", city: "亚特兰大", pos: LatLon(lat: 33.64, lon: -84.43)),
        Airport(code: "DFW", city: "达拉斯", pos: LatLon(lat: 32.90, lon: -97.04)),
        Airport(code: "YSSY", city: "悉尼", pos: LatLon(lat: -33.94, lon: 151.18)),
        Airport(code: "NZAA", city: "奥克兰", pos: LatLon(lat: -37.01, lon: 174.79)),
    ]
}
