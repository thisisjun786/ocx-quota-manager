import SwiftUI
import AppKit

struct QuotaPanel: View {
    @ObservedObject var store: QuotaStore
    var onHeightChange: (CGFloat) -> Void = { _ in }
    var screenHeight: CGFloat = NSScreen.main?.visibleFrame.height ?? 800
    @State private var tab = "summary"
    @State private var settings = false
    @State private var address = ""
    @State private var measurements: [String: CGFloat] = [:]

    private var bodyHeight: CGFloat {
        let chrome = (measurements["top"] ?? 140) + (measurements["footer"] ?? 28) + 60
        let available = max(96, screenHeight - chrome - 24)
        let content = store.snapshot == nil ? 260 : (measurements["content"] ?? 320)
        return min(max(96, content), available)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 14) {
                header
                if settings { connectionSettings }
                if let snapshot = store.snapshot { navigation(snapshot.providers) }
            }.measurePanel("top")
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let snapshot = store.snapshot {
                        if snapshot.providers.isEmpty {
                            emptyState("연결된 프로바이더가 없습니다.", symbol: "tray")
                        } else if tab == "summary" {
                            ForEach(snapshot.providers) { provider in summary(provider) }
                        } else if let provider = snapshot.providers.first(where: { $0.id == tab }) {
                            if provider.accounts.isEmpty { emptyState("등록된 계정이 없습니다.", symbol: "person.crop.circle") }
                            ForEach(provider.accounts) { account in accountRow(account) }
                        }
                    } else {
                        emptyState(store.loading ? "쿼타를 불러오는 중" : "서버에 연결해 주세요", symbol: "chart.bar.xaxis")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.vertical, 2)
                .measurePanel("content")
            }
            .frame(height: bodyHeight)
            .accessibilityIdentifier("quota-body")
            footer.measurePanel("footer")
        }
        .padding(18)
        .frame(width: 400)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(nsColor: .windowBackgroundColor))
        .measurePanel("root")
        .onPreferenceChange(PanelMeasurements.self) { values in
            measurements = values
            if let height = values["root"] { onHeightChange(height) }
        }
        .onChange(of: store.snapshot?.providers.map(\.id) ?? []) { ids in
            if tab != "summary" && !ids.contains(tab) { tab = "summary" }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.bar.fill").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.blue)
            Text("남은 쿼타").font(.system(size: 16, weight: .semibold))
            Spacer()
            if store.loading { ProgressView().controlSize(.small) }
            Button { Task { await store.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .disabled(store.loading).help("새로고침").accessibilityLabel("새로고침")
            Button { address = store.server; settings.toggle() } label: { Image(systemName: "slider.horizontal.3") }
                .help("설정").accessibilityLabel("설정")
        }
        .buttonStyle(.plain).font(.system(size: 14)).foregroundStyle(.primary)
    }

    private func navigation(_ providers: [QuotaProvider]) -> some View {
        VStack(spacing: 6) {
            tabButton("전체 요약", id: "summary")
            ScrollView {
                Grid(horizontalSpacing: 6, verticalSpacing: 6) {
                    ForEach(Array(stride(from: 0, to: providers.count, by: 3)), id: \.self) { offset in
                        GridRow {
                            ForEach(Array(providers.dropFirst(offset).prefix(3))) { provider in
                                tabButton(provider.name, id: provider.id)
                            }
                        }
                    }
                }.frame(maxWidth: .infinity).measurePanel("navigation")
            }
            .frame(height: min(measurements["navigation"] ?? 66, 120))
            .accessibilityIdentifier("quota-providers")
        }
    }

    private func tabButton(_ title: String, id: String) -> some View {
        Button { tab = id } label: {
            Text(title).font(.system(size: 12, weight: tab == id ? .semibold : .medium))
                .lineLimit(2).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 30)
                .foregroundStyle(tab == id ? Color.blue : Color.primary.opacity(0.75))
                .background(tab == id ? Color.blue.opacity(0.12) : Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain).help(title)
        .accessibilityLabel(title).accessibilityAddTraits(tab == id ? .isSelected : [])
    }

    private var connectionSettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("서버 주소").font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField("https://서버주소:포트", text: $address)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("HTTPS 서버 주소")
                Button("연결") { Task { await store.save(server: address) } }.disabled(store.loading)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let error = store.error {
                Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Button { if let url = store.origin { NSWorkspace.shared.open(url) } } label: {
                    Label("웹에서 보기", systemImage: "arrow.up.right.square")
                }.disabled(store.origin == nil)
                Spacer()
                Button("종료") { NSApplication.shared.terminate(nil) }
            }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    private func summary(_ provider: QuotaProvider) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { tab = provider.id } label: {
                HStack {
                    Text(provider.name).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if !provider.enabled { Text("비활성").font(.caption).foregroundStyle(.secondary) }
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
                }
            }.buttonStyle(.plain)
            let groups = provider.groups(now: store.now)
            if groups.isEmpty { Text("쿼타 조회 불가").foregroundStyle(.secondary).font(.caption) }
            ForEach(groups) { group in
                HStack(spacing: 12) {
                    QuotaBar(label: group.label, value: group.remainingPercent)
                    let key = "\(provider.id)/\(group.id)"
                    Button { store.pinned = key } label: {
                        Image(systemName: store.pinned == key ? "pin.fill" : "pin")
                            .font(.system(size: 11)).frame(width: 20, height: 26)
                    }.buttonStyle(.plain)
                        .foregroundStyle(store.pinned == key ? Color.blue : Color.secondary)
                        .help("\(provider.name) \(group.label) 메뉴바에 표시")
                        .accessibilityLabel("\(provider.name) \(group.label) 메뉴바에 표시")
                }
            }
        }.quotaGroup()
    }

    private func accountRow(_ account: QuotaAccount) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.label).font(.system(size: 12, weight: .semibold)).lineLimit(2)
                Spacer()
            }
            ForEach(account.windows) { window in
                QuotaBar(label: window.label, value: account.remaining(for: window, now: store.now))
            }
            if account.windows.isEmpty || account.windows.allSatisfy({ account.remaining(for: $0, now: store.now) == nil }) {
                Text(account.status == "reauth" ? "다시 로그인 필요" : account.status == "paused" ? "일시 중지" : "최신 쿼타 없음")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.quotaGroup()
    }

    private func emptyState(_ title: String, symbol: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 24)).foregroundStyle(.tertiary)
            Text(title).font(.system(size: 12)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity).frame(height: 180)
    }
}

private struct PanelMeasurements: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

private extension View {
    func measurePanel(_ key: String) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: PanelMeasurements.self, value: [key: geometry.size.height])
        })
    }
    func quotaGroup() -> some View {
        padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct QuotaBar: View {
    let label: String
    let value: Double?
    private var tint: Color { (value ?? 100) < 20 ? .orange : .blue }
    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Text(quotaPercent(value)).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(value == nil ? Color.secondary : tint)
            }
            GeometryReader { geometry in
                Capsule().fill(Color.primary.opacity(0.07))
                Capsule().fill(tint).frame(width: geometry.size.width * (value ?? 0) / 100)
            }.frame(height: 5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value == nil ? "조회 불가" : "\(quotaPercent(value)) 남음")
    }
}
