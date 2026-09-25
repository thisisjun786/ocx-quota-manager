import AppKit
import SwiftUI
import ApplicationServices

@main
struct QuotaPanelLayoutTests {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.appearance = NSAppearance(named: .aqua)
        let controller = QuotaAppDelegate()
        let observer = NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification, object: nil, queue: .main) { _ in
        Task { @MainActor in
            do {
                let accessibility = await Task.detached {
                    var role: CFTypeRef?
                    return AXUIElementCopyAttributeValue(AXUIElementCreateApplication(getpid()), kAXRoleAttribute as CFString, &role)
                }.value
                print("AX application query", accessibility.rawValue)
                controller.installMenuItem()
                if let item = Mirror(reflecting: controller).children.first(where: { $0.label == "statusItem" })?.value as? NSStatusItem {
                    try await ready { (item.button?.visibleRect.height ?? 0) > 0 }
                }
                controller.showPanel()
                try await ready { controller.popover.isShown && controller.popover.contentSize.height >= 280 }
                try check(controller.popover.contentViewController?.view.window?.isVisible == true, "actual popup must be visible")
                print("PASS loading actual popup", controller.popover.contentSize)
                controller.store.snapshot = fixture(providers: 1, accounts: 1)
                try await ready { controller.popover.contentSize.height < 550 }
                try await stable(controller)
                let shortHeight = controller.popover.contentSize.height
                print("PASS short actual popup", controller.popover.contentSize)
                controller.store.snapshot = fixture(providers: 30, accounts: 3)
                try await ready { controller.popover.contentSize.height > shortHeight + 100 }
                try await stable(controller)
                let limit = (controller.popover.contentViewController?.view.window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
                try check(controller.popover.contentSize.height <= limit, "long popup must fit screen")
                print("PASS 30-provider actual popup", controller.popover.contentSize, "screen", limit)
                guard let root = controller.popover.contentViewController?.view else { throw Failure(description: "no popup view") }
                try check(press("Provider 0 long name", in: root), "provider selection action")
                try await stable(controller)
                print("PASS provider tab", controller.popover.contentSize)
                try capture(controller, name: "provider")
                try check(press("설정", in: root), "settings action")
                try await stable(controller)
                try check(controller.popover.contentSize.height <= limit, "settings popup fits screen")
                print("PASS settings", controller.popover.contentSize)
                try capture(controller, name: "settings")
                try check(press("설정", in: root), "close settings action")
                try check(press("전체 요약", in: root), "return to summary")
                try await stable(controller)

                controller.store.error = "연결 실패 · Tailscale과 서버 주소를 확인해 주세요."
                try await stable(controller)
                try check(controller.popover.contentSize.height <= limit, "error chrome must fit")
                controller.store.snapshot = fixture(providers: 1, accounts: 1)
                try await ready { controller.popover.contentSize.height < 550 }
                try await stable(controller)
                print("PASS shrinks after long content", controller.popover.contentSize)
                controller.popover.close()
                try check(!controller.popover.isShown, "popover closes")
                controller.showPanel()
                try await ready { controller.popover.isShown && controller.popover.contentSize.height >= 280 }
                print("PASS reopen actual popup", controller.popover.contentSize)
                controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
                print("QuotaPanelLayoutTests passed; native popup closed")
                app.terminate(nil)
            } catch {
                print("FAIL", error, "shown", controller.popover.isShown, "size", controller.popover.contentSize, "window", controller.popover.contentViewController?.view.window as Any)
                controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
                exit(1)
            }
        }
        }
        withExtendedLifetime(observer) { app.run() }
    }

    @MainActor static func ready(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !predicate() {
            if Date() > deadline { throw Failure(description: "layout readiness timed out") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @MainActor static func stable(_ controller: QuotaAppDelegate) async throws {
        var previous = NSSize.zero
        var matches = 0
        let deadline = Date().addingTimeInterval(5)
        while matches < 4 {
            controller.popover.contentViewController?.view.layoutSubtreeIfNeeded()
            let size = controller.popover.contentSize
            matches = size == previous ? matches + 1 : 0
            previous = size
            if Date() > deadline { throw Failure(description: "popup did not settle") }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
    }

    @MainActor static func capture(_ controller: QuotaAppDelegate, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTA_QA_DIR"] else { return }
        guard let view = controller.popover.contentViewController?.view,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw Failure(description: "popup capture unavailable") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failure(description: "PNG unavailable") }
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try png.write(to: URL(fileURLWithPath: path).appendingPathComponent(name + ".png"))
    }

    @MainActor static func press(_ label: String, in node: Any) -> Bool {
        guard let object = node as? NSObject else { return false }
        func attribute(_ name: String) -> Any? {
            let selector = NSSelectorFromString(name)
            return object.responds(to: selector) ? object.perform(selector)?.takeUnretainedValue() : nil
        }
        let title = attribute("accessibilityLabel") as? String ?? attribute("accessibilityTitle") as? String
        if title == label {
            let selector = NSSelectorFromString("accessibilityPerformPress")
            if object.responds(to: selector), let method = object.method(for: selector) {
                // SwiftUI AX nodes implement Objective-C methods without declaring the formal protocol.
                typealias Press = @convention(c) (AnyObject, Selector) -> Bool
                return unsafeBitCast(method, to: Press.self)(object, selector)
            }
        }
        for child in attribute("accessibilityChildren") as? [Any] ?? [] {
            if press(label, in: child) { return true }
        }
        return false
    }

    static func fixture(providers: Int, accounts: Int) -> QuotaSnapshot {
        let time = ISO8601DateFormatter().string(from: Date())
        let list = (0..<providers).map { p in
            QuotaProvider(id: "provider-\(p)", name: "Provider \(p) long name", enabled: true,
                accounts: (0..<accounts).map { a in
                    QuotaAccount(id: "account-\(a)", label: "Account \(a)", plan: "Pro", status: "ok", updatedAt: time,
                        windows: [QuotaWindow(id: "weekly", label: "주간", remainingPercent: 72, stale: false, resetAt: nil, usageScope: nil),
                                  QuotaWindow(id: "short", label: "5시간", remainingPercent: 18, stale: false, resetAt: nil, usageScope: nil)])
                })
        }
        return QuotaSnapshot(schemaVersion: 1, observedAt: time, providers: list)
    }
    static func check(_ value: Bool, _ description: String) throws { if !value { throw Failure(description: description) } }
    struct Failure: Error { let description: String }
}
