import AppKit

@main
struct QuotaMonitorApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = QuotaAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
