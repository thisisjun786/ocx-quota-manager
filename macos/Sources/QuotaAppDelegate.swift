import AppKit
import SwiftUI
import Combine

@MainActor
final class QuotaAppDelegate: NSObject, NSApplicationDelegate {
    let store = QuotaStore()
    let popover = NSPopover()
    private var statusItem: NSStatusItem?
    private var observation: AnyCancellable?
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenuItem()
        Task { await store.refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.store.refresh() }
        }
    }

    func installMenuItem() {
        NSApp.setActivationPolicy(.accessory)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        item.button?.target = self
        item.button?.action = #selector(togglePanel)
        item.button?.image = NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: "남은 쿼타")
        item.button?.imagePosition = .imageLeading
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        popover.behavior = .transient
        popover.animates = false
        popover.contentSize = NSSize(width: 400, height: 360)
        configureContent()
        updateTitle()
        observation = store.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateTitle() }
        }
    }

    private var displayHeight: CGFloat {
        (statusItem?.button?.window?.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.height ?? 800
    }

    private func configureContent() {
        popover.contentViewController = NSHostingController(rootView:
            QuotaPanel(store: store, onHeightChange: { [weak self] height in
                guard let self else { return }
                let size = NSSize(width: 400, height: min(height, self.displayHeight - 16))
                if abs(self.popover.contentSize.height - size.height) > 0.5 { self.popover.contentSize = size }
            }, screenHeight: displayHeight)
        )
    }

    private func updateTitle() {
        statusItem?.button?.title = " " + store.menuTitle
    }

    @objc func togglePanel() {
        if popover.isShown { popover.performClose(nil) } else { showPanel() }
    }

    func showPanel() {
        guard let button = statusItem?.button else { return }
        configureContent()
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        popover.close()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    }
}
