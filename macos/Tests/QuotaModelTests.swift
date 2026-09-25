import Foundation

@main
struct QuotaModelTests {
    static let now = Date(timeIntervalSince1970: 1_700_000_000)

    static func main() throws {
        try decodesFixtureAndAveragesEqualAccounts()
        try separatesCustomUsageScopes()
        try hidesCodexSparkWindows()
        try excludesUnavailableAndExpiredValues()
        try checksFreshAccountsAtEachBoundary()
        try decodesNullableStale()
        try rejectsMalformedSnapshot()
        print("QuotaModelTests passed")
    }

    static func decodesFixtureAndAveragesEqualAccounts() throws {
        let snapshot = try decode("""
        {
          "schemaVersion": 1,
          "observedAt": "2023-11-14T22:13:20Z",
          "providers": [{
            "id": "openai", "name": "OpenAI", "enabled": true,
            "accounts": [
              {"id": "one", "label": "One", "plan": "pro", "status": "ok", "updatedAt": "2023-11-14T22:10:00Z", "windows": [{"id": "weekly", "label": "Weekly", "remainingPercent": 80, "stale": false, "resetAt": "2023-11-15T22:13:20Z"}]},
              {"id": "two", "label": "Two", "plan": null, "status": "ok", "updatedAt": "2023-11-14T22:05:00Z", "windows": [{"id": "weekly", "label": "Weekly", "remainingPercent": 40, "stale": false, "resetAt": null}]}
            ]
          }]
        }
        """)

        try expect(snapshot.schemaVersion == 1, "fixture should decode")
        let groups = snapshot.providers[0].groups(now: now)
        try expect(groups.count == 1, "matching windows should form one group")
        try expect(groups[0].label == "Weekly", "group keeps the window label")
        try expect(groups[0].remainingPercent == 60, "group uses the equal-account average")
    }

    static func separatesCustomUsageScopes() throws {
        let account = QuotaAccount(
            id: "one", label: "One", plan: nil, status: "ok", updatedAt: "2023-11-14T22:10:00Z",
            windows: [
                QuotaWindow(id: "custom-0", label: "Weekly", remainingPercent: 70, stale: false, resetAt: nil, usageScope: "all"),
                QuotaWindow(id: "custom-1", label: "Weekly", remainingPercent: 30, stale: false, resetAt: nil, usageScope: "fable")
            ]
        )
        let groups = QuotaProvider(id: "anthropic", name: "Anthropic", enabled: true, accounts: [account]).groups(now: now)

        try expect(groups.count == 2, "custom windows with separate scopes must not merge")
        try expect(groups.map(\.remainingPercent).contains(70), "all-scope custom window remains available")
        try expect(groups.map(\.remainingPercent).contains(30), "fable custom window remains available")
    }

    static func hidesCodexSparkWindows() throws {
        let account = QuotaAccount(
            id: "one", label: "One", plan: nil, status: "ok", updatedAt: "2023-11-14T22:10:00Z",
            windows: [
                QuotaWindow(id: "weekly", label: "Weekly", remainingPercent: 80, stale: false, resetAt: nil, usageScope: nil),
                QuotaWindow(id: "custom-0", label: "GPT-5.3-Codex-Spark 5h", remainingPercent: 100, stale: false, resetAt: nil, usageScope: nil),
                QuotaWindow(id: "custom-1", label: "GPT-5.3-Codex-Spark Weekly", remainingPercent: 100, stale: false, resetAt: nil, usageScope: nil)
            ]
        )
        let groups = QuotaProvider(id: "openai", name: "OpenAI", enabled: true, accounts: [account]).groups(now: now)

        try expect(groups.count == 1, "Codex Spark windows stay hidden, matching the web dashboard")
        try expect(groups[0].remainingPercent == 80, "the remaining window keeps its own average")
    }

    static func excludesUnavailableAndExpiredValues() throws {
        let account = QuotaAccount(
            id: "one", label: "One", plan: nil, status: "ok", updatedAt: "2023-11-14T21:58:19Z",
            windows: [
                QuotaWindow(id: "weekly", label: "Weekly", remainingPercent: 90, stale: false, resetAt: nil, usageScope: nil),
                QuotaWindow(id: "monthly", label: "Monthly", remainingPercent: nil, stale: false, resetAt: nil, usageScope: nil),
                QuotaWindow(id: "short", label: "Short", remainingPercent: 50, stale: false, resetAt: "2023-11-14T22:13:19Z", usageScope: nil),
                QuotaWindow(id: "five-hour", label: "Five hour", remainingPercent: 20, stale: true, resetAt: nil, usageScope: nil)
            ]
        )
        let paused = QuotaAccount(
            id: "two", label: "Two", plan: nil, status: "paused", updatedAt: "2023-11-14T22:10:00Z",
            windows: [QuotaWindow(id: "weekly", label: "Weekly", remainingPercent: 10, stale: false, resetAt: nil, usageScope: nil)]
        )
        let reauth = QuotaAccount(
            id: "three", label: "Three", plan: nil, status: "reauth", updatedAt: "2023-11-14T22:10:00Z",
            windows: [QuotaWindow(id: "weekly", label: "Weekly", remainingPercent: 10, stale: false, resetAt: nil, usageScope: nil)]
        )
        let groups = QuotaProvider(id: "openai", name: "OpenAI", enabled: true, accounts: [account, paused, reauth]).groups(now: now)

        try expect(account.remaining(for: account.windows[0], now: now) == nil, "updates older than fifteen minutes are unavailable")
        try expect(account.remaining(for: account.windows[1], now: now) == nil, "missing remaining values are unavailable")
        try expect(account.remaining(for: account.windows[2], now: now) == nil, "elapsed reset times are unavailable")
        try expect(account.remaining(for: account.windows[3], now: now) == nil, "stale values are unavailable")
        try expect(groups.allSatisfy { $0.remainingPercent == nil }, "expired, missing, and paused values do not contribute")
    }

    static func rejectsMalformedSnapshot() throws {
        let malformed = #"{"schemaVersion":1,"observedAt":"now","providers":[{"id":"openai","name":"OpenAI","enabled":true,"accounts":[{"id":"one","label":"One","windows":[]}]}]}"#
        do {
            _ = try decode(malformed)
            throw TestFailure("missing required provider fields must fail decoding")
        } catch is DecodingError {
            return
        }
    }

    static func checksFreshAccountsAtEachBoundary() throws {
        func value(status: String = "ok", percent: Double? = 50, stale: Bool = false,
                   updated: String? = "2023-11-14T22:13:20.000Z", reset: String? = nil) -> Double? {
            let window = QuotaWindow(id: "weekly", label: "Weekly", remainingPercent: percent,
                                     stale: stale, resetAt: reset, usageScope: nil)
            return QuotaAccount(id: "test", label: "Test", plan: nil, status: status,
                                updatedAt: updated, windows: [window]).remaining(for: window, now: now)
        }
        try expect(value() == 50, "fractional ISO timestamps decode")
        try expect(value(percent: 0) == 0, "zero is a measured value")
        try expect(value(percent: 100) == 100, "full quota is measured")
        try expect(value(status: "paused") == nil, "paused account detail is unavailable")
        try expect(value(status: "reauth") == nil, "reauth account detail is unavailable")
        try expect(value(percent: -1) == nil && value(percent: 101) == nil, "reject invalid ranges")
        try expect(value(percent: nil) == nil, "missing quota is not zero")
        try expect(value(stale: true) == nil, "server stale flag wins")
        try expect(value(updated: nil) == nil, "missing observation is unavailable")
        try expect(value(updated: "2023-11-14T22:15:00Z") == nil, "future observation is unavailable")
        try expect(value(reset: "2023-11-14T22:13:20Z") == nil, "elapsed reset is unavailable")
        try expect(value(reset: "invalid") == nil, "malformed reset is unavailable")
        try expect(value(updated: "2023-11-14T21:58:20Z") == 50, "fifteen-minute boundary matches server")
    }

    static func decodesNullableStale() throws {
        let window = try JSONDecoder().decode(QuotaWindow.self, from: Data(#"{"id":"weekly","label":"Weekly","remainingPercent":75,"stale":null}"#.utf8))
        let account = QuotaAccount(id: "one", label: "One", plan: nil, status: "ok",
                                   updatedAt: "2023-11-14T22:13:20Z", windows: [window])
        try expect(account.remaining(for: window, now: now) == 75, "nullable stale still checks observation age")
        try expect(account.remaining(for: window, now: now.addingTimeInterval(901)) == nil, "nullable stale never bypasses expiration")
    }

    static func decode(_ fixture: String) throws -> QuotaSnapshot {
        try JSONDecoder().decode(QuotaSnapshot.self, from: Data(fixture.utf8))
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw TestFailure(message) }
    }
}

struct TestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
