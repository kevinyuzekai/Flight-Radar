//
//  Core.swift — 地理计算 + 数据模型
//
import Foundation

// MARK: - 地理

enum Geo {
    static let earthRadiusKm = 6371.0

    /// 两点大圆距离（km）
    static func distanceKm(_ a: LatLon, _ b: LatLon) -> Double {
        let dLat = (b.lat - a.lat) * .pi / 180
        let dLon = (b.lon - a.lon) * .pi / 180
        let la1 = a.lat * .pi / 180
        let la2 = b.lat * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(la1) * cos(la2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earthRadiusKm * asin(min(1, sqrt(h)))
    }

    /// 方位角（度，正北为 0，顺时针）
    static func bearing(from a: LatLon, to b: LatLon) -> Double {
        let la1 = a.lat * .pi / 180
        let la2 = b.lat * .pi / 180
        let dLon = (b.lon - a.lon) * .pi / 180
        let y = sin(dLon) * cos(la2)
        let x = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dLon)
        var deg = atan2(y, x) * 180 / .pi
        if deg < 0 { deg += 360 }
        return deg
    }

    /// 把经纬度规整到合法范围
    static func wrap(_ p: LatLon) -> LatLon {
        var lon = p.lon.truncatingRemainder(dividingBy: 360)
        if lon < -180 { lon += 360 }
        if lon > 180 { lon -= 360 }
        return LatLon(lat: max(-89.9, min(89.9, p.lat)), lon: lon)
    }
}

struct LatLon: Codable, Equatable {
    var lat: Double
    var lon: Double

    var shortText: String {
        String(format: "%.2f°%@ %.2f°%@",
               abs(lat), lat >= 0 ? "N" : "S",
               abs(lon), lon >= 0 ? "E" : "W")
    }
}

// MARK: - 飞机

struct Aircraft {
    let hex: String
    let callsign: String
    let type: String          // 机型代码，如 A388 / B748
    let registration: String
    let lat: Double
    let lon: Double
    let altitudeFt: Int       // -1 表示地面
    let groundSpeedKt: Int
    let track: Double         // 航向
    let verticalRate: Int
    let onGround: Bool
    /// 这条位置的真实定位时刻（= 数据快照时刻 now - seen_pos），用于外推与新旧比较
    var fixTime: Double = 0
    /// 最后一次在数据里出现的时刻（用于 60 秒保留）
    var lastSeen: Double = 0
    /// 数据源：lol / fi
    var source: String = ""

    var position: LatLon { LatLon(lat: lat, lon: lon) }
    var isAirborne: Bool { !onGround && altitudeFt > 0 }
    var displayName: String { callsign.isEmpty ? hex.uppercased() : callsign }
}

/// 机型归类（与图标体系一致，用于「拍机警报」的关注列表）
enum AircraftClass: String, CaseIterable, Codable {
    case a380, b747, widebody, a330, narrowbody, regional, turboprop, light, heli, fighter

    var label: String {
        switch self {
        case .a380: return "A380"
        case .b747: return "B747"
        case .widebody: return "宽体"
        case .a330: return "A330"
        case .narrowbody: return "窄体"
        case .regional: return "支线"
        case .turboprop: return "涡桨"
        case .light: return "通航"
        case .heli: return "直升机"
        case .fighter: return "战机"
        }
    }

    static let table: [(AircraftClass, [String])] = [
        (.a380, ["A38"]),
        (.b747, ["B74"]),
        (.a330, ["A33"]),
        (.widebody, ["B77", "B78", "A35", "A34", "B76", "IL96", "A30", "A3ST", "C5M", "AN12", "AN22"]),
        (.narrowbody, ["A31", "A32", "A19", "A20", "A21", "B73", "B75", "MD8", "MD9", "B71", "CS3", "BCS"]),
        (.regional, ["CRJ", "E1", "E2", "EMB", "ERJ", "GLF", "GLA", "C25", "C5", "C68", "C75", "F2T", "E55", "E50", "HDJ", "PC24", "LJ", "FA", "BE4", "BE2", "BE3", "H25", "SBR", "WW2", "CL3", "CL6"]),
        (.turboprop, ["AT4", "AT7", "DH8", "DHC", "Q40", "SF3", "SB2", "J32", "B19", "C20", "PC12", "TBM", "BE9", "BE1", "MET", "AC6", "C44"]),
        (.heli, ["H1", "H2", "H3", "H4", "EC1", "EC2", "EC3", "AS3", "AS5", "AS6", "R2", "R44", "R66", "B4", "AW1", "UH", "CH"]),
        (.fighter, ["F1", "F2", "F3", "F4", "F5", "F8", "FA1", "EA1", "MIG", "SU", "JAS", "T38", "A10", "AV8"]),
    ]

    static func classify(_ type: String) -> AircraftClass {
        let t = type.uppercased().filter { $0.isLetter || $0.isNumber }
        if t.isEmpty { return .narrowbody }
        for (cls, prefixes) in table {
            for p in prefixes where t.hasPrefix(p) { return cls }
        }
        return .narrowbody
    }
}

// MARK: - 航空公司（呼号前缀 → 中文名）

enum Airlines {
    static let table: [String: String] = [
        "UAE": "阿联酋航空", "CCA": "中国国航", "CES": "中国东航", "CSN": "中国南航",
        "CHH": "海南航空", "CSZ": "深圳航空", "CXA": "厦门航空", "CSC": "四川航空",
        "CBA": "中国联航", "GCR": "天津航空", "CQH": "春航空", "JYH": "九元航空",
        "BAW": "英国航空", "AFR": "法国航空", "DLH": "汉莎航空", "KLM": "荷兰皇家航空",
        "SWR": "瑞士航空", "IBE": "伊比利亚航空", "THY": "土耳其航空", "AEE": "爱琴海航空",
        "AAL": "美国航空", "DAL": "达美航空", "UAL": "美联航", "SWA": "西南航空",
        "JBU": "捷蓝航空", "ASA": "阿拉斯加航空", "FDX": "联邦快递", "UPS": "UPS",
        "GTI": "阿特拉斯航空", "CAL": "中华航空", "EVA": "长荣航空", "CPA": "国泰航空",
        "ANA": "全日空", "JAL": "日本航空", "KAL": "大韩航空", "AAR": "韩亚航空",
        "SIA": "新加坡航空", "MAS": "马来西亚航空", "THA": "泰国航空", "AXM": "亚洲航空",
        "QFA": "澳洲航空", "ANZ": "新西兰航空", "ETD": "阿提哈德航空", "QTR": "卡塔尔航空",
        "SVA": "沙特航空", "EK": "阿联酋航空", "RYR": "瑞安航空", "EZY": "易捷航空",
        "VLG": "伏林航空", "WZZ": "威兹航空", "FIN": "芬兰航空", "SAS": "北欧航空",
        "AIC": "印度航空", "VTI": "维斯塔拉", "IGO": "靛蓝航空", "AMX": "墨西哥航空",
        "LAN": "南美航空", "GLO": "戈尔航空", "AZU": "蓝色巴西航空", "ETH": "埃塞俄比亚航空",
        "SAA": "南非航空", "RAM": "摩洛哥航空", "MSR": "埃及航空", "KAC": "科威特航空",
    ]

    /// 从呼号推断航空公司：优先取 3 字码
    static func name(for callsign: String) -> String? {
        let cs = callsign.uppercased().trimmingCharacters(in: .whitespaces)
        guard cs.count >= 3 else { return nil }
        if let n = table[String(cs.prefix(3))] { return n }
        if let n = table[String(cs.prefix(2))] { return n }
        return nil
    }

    /// 机型 → 友好名
    static func typeName(_ code: String) -> String {
        let t = code.uppercased()
        let map: [String: String] = [
            "A388": "空客 A380", "A380": "空客 A380", "A359": "空客 A350-900",
            "A35K": "空客 A350-1000", "A333": "空客 A330-300", "A332": "空客 A330-200",
            "A320": "空客 A320", "A321": "空客 A321", "A319": "空客 A319",
            "A20N": "空客 A320neo", "A21N": "空客 A321neo", "B744": "波音 747-400",
            "B748": "波音 747-8", "B77W": "波音 777-300ER", "B772": "波音 777-200",
            "B789": "波音 787-9", "B788": "波音 787-8", "B738": "波音 737-800",
            "B739": "波音 737-900", "B38M": "波音 737 MAX 8", "B752": "波音 757-200",
            "E190": "巴航 E190", "CRJ9": "庞巴迪 CRJ900", "AT76": "ATR 72-600",
            "DH8D": "冲 8-400",
        ]
        return map[t] ?? (t.isEmpty ? "未知机型" : t)
    }
}
