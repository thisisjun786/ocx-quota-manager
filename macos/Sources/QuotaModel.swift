import Foundation

struct QuotaSnapshot: Decodable {
    let schemaVersion: Int
    let observedAt: String
    let providers: [QuotaProvider]
}

struct QuotaProvider: Decodable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
    let accounts: [QuotaAccount]

    func groups(now: Date) -> [QuotaGroup] {
        var order: [String] = []
        var labels: [String: String] = [:]
        var totals: [String: Double] = [:]
        var counts: [String: Int] = [:]

        for account in accounts {
            for window in account.windows where !window.isHidden {
                let key = groupKey(for: window)
                if labels[key] == nil {
                    order.append(key)
                    labels[key] = window.label
                }

                guard !["reauth", "paused"].contains(account.status),
                      let remaining = account.remaining(for: window, now: now)
                else {
                    continue
                }

                totals[key, default: 0] += remaining
                counts[key, default: 0] += 1
            }
        }

        return order.map { key in
            let remaining = counts[key].map { totals[key, default: 0] / Double($0) }
            return QuotaGroup(id: key, label: labels[key] ?? key, remainingPercent: remaining)
        }
    }

    private func groupKey(for window: QuotaWindow) -> String {
        let normalizedID = window.id.hasPrefix("custom-") ? "custom" : window.id
        return [normalizedID, window.usageScope ?? "", window.label].joined(separator: ":")
    }
}

struct QuotaAccount: Decodable, Identifiable {
    let id: String
    let label: String
    let plan: String?
    let status: String
    let updatedAt: String?
    let windows: [QuotaWindow]

    func remaining(for window: QuotaWindow, now: Date) -> Double? {
        guard !["reauth", "paused", "unavailable"].contains(status), window.stale != true,
              let remaining = window.remainingPercent,
              remaining.isFinite, (0...100).contains(remaining),
              let updatedAt,
              let updated = Self.date(from: updatedAt)
        else {
            return nil
        }

        let age = now.timeIntervalSince(updated)
        guard age <= 15 * 60, age >= -60 else { return nil }

        if let resetAt = window.resetAt {
            guard let reset = Self.date(from: resetAt), reset > now else { return nil }
        }

        return remaining
    }

    private static func date(from value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
            ?? ISO8601DateFormatter().date(from: value)
    }
}

struct QuotaWindow: Decodable, Identifiable {
    let id: String
    let label: String
    let remainingPercent: Double?
    let stale: Bool?
    let resetAt: String?
    let usageScope: String?

    // The web dashboard hides Codex Spark windows. The panel follows the same rule
    // so the summary and the menu-bar pin list describe one set of limits.
    var isHidden: Bool {
        label.range(of: "\\bspark\\b", options: [.regularExpression, .caseInsensitive]) != nil
    }
}

struct QuotaGroup: Identifiable {
    let id: String
    let label: String
    let remainingPercent: Double?
}
