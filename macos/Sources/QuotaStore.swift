import Foundation
import Combine

@MainActor
final class QuotaStore: ObservableObject {
    @Published var snapshot: QuotaSnapshot?
    @Published var loading = false
    @Published var error: String?
    @Published var now = Date()
    @Published var server: String
    @Published var pinned: String {
        didSet { UserDefaults.standard.set(pinned, forKey: "pinnedQuota") }
    }
    private let session = URLSession(configuration: .ephemeral)

    init() {
        server = UserDefaults.standard.string(forKey: "serverURL") ?? "http://127.0.0.1:8787"
        pinned = UserDefaults.standard.string(forKey: "pinnedQuota") ?? ""
    }

    var origin: URL? {
        Self.origin(for: server)
    }

    private static func origin(for value: String) -> URL? {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { return nil }
        return url
    }

    var menuTitle: String {
        guard let snapshot else { return "쿼타 —" }
        for provider in snapshot.providers {
            for group in provider.groups(now: now) where "\(provider.id)/\(group.id)" == pinned {
                return "\(provider.name) \(quotaPercent(group.remainingPercent))\(error == nil ? "" : " !")"
            }
        }
        return error == nil ? "쿼타" : "쿼타 !"
    }

    func save(server value: String) async {
        guard !loading else { return }
        let candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.origin(for: candidate) != nil else {
            error = "HTTPS 서버 주소를 입력해 주세요."
            return
        }
        server = candidate
        UserDefaults.standard.set(server, forKey: "serverURL")
        snapshot = nil
        await refresh()
    }

    func refresh() async {
        now = Date()
        guard !loading else { return }
        guard let origin else { error = "설정에서 HTTPS 서버 주소를 확인해 주세요."; return }
        loading = true
        defer { loading = false }
        do {
            var request = URLRequest(url: origin.appendingPathComponent("api/v1/snapshot"))
            request.timeoutInterval = 15
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  data.count <= 8 * 1024 * 1024 else { throw URLError(.badServerResponse) }
            let value = try JSONDecoder().decode(QuotaSnapshot.self, from: data)
            guard value.schemaVersion == 1 else { throw URLError(.cannotParseResponse) }
            snapshot = value
            error = nil
            if pinned.isEmpty, let provider = value.providers.first(where: { !$0.groups(now: now).isEmpty }),
               let group = provider.groups(now: now).first {
                pinned = "\(provider.id)/\(group.id)"
            }
        } catch {
            self.error = "연결 실패 · Tailscale과 서버 주소를 확인해 주세요."
        }
    }
}

func quotaPercent(_ value: Double?) -> String {
    guard let value else { return "—" }
    return String(format: "%.0f%%", value)
}
