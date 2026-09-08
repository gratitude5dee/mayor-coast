import Foundation
import UIKit

@MainActor
final class DrawSessionModel: ObservableObject {
    enum Phase: Equatable {
        case waitingForCard
        case connecting
        case ready
        case preparing
        case generating
        case sending
        case delivered
        case failed(String)

        var label: String {
            switch self {
            case .waitingForCard: "Open a /draw card"
            case .connecting: "Opening…"
            case .ready: "Ready"
            case .preparing: "Preparing…"
            case .generating: "Generating…"
            case .sending: "Sending…"
            case .delivered: "Delivered"
            case .failed(let message): message
            }
        }

        var isBusy: Bool {
            [.connecting, .preparing, .generating, .sending].contains(self)
        }
    }

    struct DrawEvent: Decodable {
        let sequence: Int
        let state: String
        let mediaId: String?
    }

    struct Status: Decodable { let events: [DrawEvent] }
    struct Upload: Decodable { let mediaId: String }
    struct Generation: Decodable { let jobId: String; let state: String }

    @Published private(set) var phase: Phase = .waitingForCard
    @Published private(set) var resultImage: UIImage?

    private var baseURL: URL?
    private var sessionID: String?
    private var pollTask: Task<Void, Never>?
    private let client: URLSession

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        client = URLSession(configuration: configuration)
    }

    func open(messageURL: URL?) async {
        guard let messageURL,
              let host = messageURL.host,
              let scheme = messageURL.scheme,
              let id = messageURL.pathComponents.last,
              !id.isEmpty else {
            phase = .waitingForCard
            return
        }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = messageURL.port
        guard let root = origin.url else { phase = .failed("Invalid draw card"); return }
        baseURL = root
        sessionID = id
        phase = .connecting

        do {
            if let secret = Self.fragmentValue(named: "secret", in: messageURL) {
                do { try await exchange(secret: secret) }
                catch { try await refresh() }
            } else {
                try await refresh()
            }
            if phase == .connecting { phase = .ready }
            startPolling()
        } catch {
            phase = .failed("Send /draw again for a fresh card")
        }
    }

    func pause() {
        pollTask?.cancel()
        pollTask = nil
    }

    func generate(prompt: String, imageData: Data?) async {
        guard !phase.isBusy else { return }
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard imageData != nil || !cleanPrompt.isEmpty else {
            phase = .failed("Add a sketch or prompt")
            return
        }
        phase = .preparing
        do {
            let mediaID: String?
            if let imageData { mediaID = try await upload(imageData) }
            else { mediaID = nil }
            var body: [String: String] = ["requestKey": UUID().uuidString, "prompt": cleanPrompt]
            if let mediaID { body["mediaId"] = mediaID }
            let data = try JSONSerialization.data(withJSONObject: body)
            let response: Generation = try await send(path: "generations", method: "POST", body: data, contentType: "application/json")
            phase = response.state == "awaiting_payment" ? .failed("Add credit in iMessage") : .generating
            startPolling()
        } catch {
            phase = .failed("Couldn’t start this image")
        }
    }

    private func exchange(secret: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["secret": secret])
        let _: Exchange = try await send(path: "exchange", method: "POST", body: data, contentType: "application/json")
    }

    private struct Exchange: Decodable { let ok: Bool }

    private func upload(_ data: Data) async throws -> String {
        guard data.count <= 3 * 1_024 * 1_024 else { throw ClientError.invalidResponse }
        let response: Upload = try await send(path: "media", method: "POST", body: data, contentType: "image/png")
        return response.mediaId
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                try? await self.refresh()
                if self.phase == .delivered { return }
            }
        }
    }

    private func refresh() async throws {
        let status: Status = try await send(path: "status", method: "GET")
        guard let event = status.events.last else {
            if phase == .connecting { phase = .ready }
            return
        }
        switch event.state {
        case "admitted", "submitting", "queued", "running": phase = .generating
        case "ready_for_delivery", "delivering": phase = .sending
        case "delivered": phase = .delivered
        case "failed", "terminal_failure", "refused": phase = .failed("Try a different idea")
        case "cancelled", "expired": phase = .failed("This request ended")
        default: break
        }
        if let mediaID = event.mediaId { resultImage = try await fetchImage(mediaID: mediaID) }
    }

    private func fetchImage(mediaID: String) async throws -> UIImage {
        let (data, response) = try await request(path: "media/\(mediaID)", method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: data) else { throw ClientError.invalidResponse }
        return image
    }

    private func send<Response: Decodable>(path: String, method: String, body: Data? = nil, contentType: String? = nil) async throws -> Response {
        let (data, response) = try await request(path: path, method: method, body: body, contentType: contentType)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw ClientError.invalidResponse }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func request(path: String, method: String, body: Data? = nil, contentType: String? = nil) async throws -> (Data, URLResponse) {
        guard let baseURL, let sessionID else { throw ClientError.invalidSession }
        var url = baseURL.appendingPathComponent("api/draw/sessions").appendingPathComponent(sessionID)
        for component in path.split(separator: "/") { url.appendPathComponent(String(component)) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = true
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "content-type") }
        return try await client.data(for: request)
    }

    private static func fragmentValue(named name: String, in url: URL) -> String? {
        guard let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
              let components = URLComponents(string: "?\(fragment)") else { return nil }
        return components.queryItems?.first(where: { $0.name == name })?.value
    }

    private enum ClientError: Error { case invalidSession, invalidResponse }
}
