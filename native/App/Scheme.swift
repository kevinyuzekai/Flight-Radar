//
//  Scheme.swift — app:// 静态资源 + radar:// 数据代理
//
import Cocoa
import WebKit

let APP_HOST = "local"
let ALLOWED_HOSTS: Set<String> = ["api.adsb.lol", "opendata.adsb.fi", "api.adsb.fi"]

let MIME: [String: String] = [
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "svg": "image/svg+xml",
    "wasm": "application/wasm",
]

/// app://local/... → Resources/app/...
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/ui/index.html" }

        let target = root.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else {
            send(task, 403, "text/plain", Data("Forbidden".utf8)); return
        }
        guard let body = try? Data(contentsOf: target) else {
            send(task, 404, "text/plain", Data("Not found".utf8)); return
        }
        let ext = target.pathExtension.lowercased()
        send(task, 200, MIME[ext] ?? "application/octet-stream", body)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func send(_ task: WKURLSchemeTask, _ status: Int, _ mime: String, _ body: Data) {
        lock.lock(); let dead = stopped.contains(ObjectIdentifier(task)); lock.unlock()
        guard !dead, let url = task.request.url else { return }
        let headers = ["Content-Type": mime,
                       "Content-Length": String(body.count),
                       "Cache-Control": "no-cache",
                       "Access-Control-Allow-Origin": "*"]
        guard let resp = HTTPURLResponse(url: url, statusCode: status,
                                         httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(resp)
        task.didReceive(body)
        task.didFinish()
    }
}

/// radar://fetch/?url=... → URLSession 出网（绕开 CORS）
final class ProxySchemeHandler: NSObject, WKURLSchemeHandler {
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = comps.queryItems?.first(where: { $0.name == "url" })?.value,
              let target = URL(string: raw), let host = target.host,
              ALLOWED_HOSTS.contains(host) else {
            respond(task, 400, Data("bad request".utf8)); return
        }

        var req = URLRequest(url: target)
        req.timeoutInterval = 45
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("FlightRadar/2.0 (Mac)", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            if let err {
                self.respond(task, 502, Data(err.localizedDescription.utf8)); return
            }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 200
            self.respond(task, status, data ?? Data())
        }.resume()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    private func respond(_ task: WKURLSchemeTask, _ status: Int, _ body: Data) {
        lock.lock(); let dead = stopped.contains(ObjectIdentifier(task)); lock.unlock()
        guard !dead, let url = task.request.url else { return }
        let headers = ["Content-Type": "application/json; charset=utf-8",
                       "Access-Control-Allow-Origin": "*",
                       "Cache-Control": "no-store",
                       "Content-Length": String(body.count)]
        guard let resp = HTTPURLResponse(url: url, statusCode: status,
                                         httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(resp)
        task.didReceive(body)
        task.didFinish()
    }
}
