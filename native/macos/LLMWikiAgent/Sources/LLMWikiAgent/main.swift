import AppKit
import CoreGraphics
import ServiceManagement
import UniformTypeIdentifiers
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var windowMenu: NSMenu!
    private var serverProcess: Process?
    private var isTerminating = false
    private var serverRestartAttempts = 0
    private var startAtLoginItem: NSMenuItem!
    private var dockIconItem: NSMenuItem!
    private var closeBehaviorItem: NSMenuItem!
    private var setupAlertItem: NSMenuItem!
    private var snapWindows: [NSWindow] = []
    private var childWindows: [NSWindow] = []
    private var notificationPollTimer: Timer?
    private var navigationRetryCounts: [ObjectIdentifier: Int] = [:]
    private weak var snapBoxView: NSView?
    private weak var snapTextView: WKWebView?
    private let closeBehaviorKey = "closeButtonKeepsRunning"
    private let hideSetupAlertKey = "hideSetupRequiredOnStartup"
    private let configPathKey = "configFilePath"
    private let snapSizeKey = "snapTextSize"
    private let port = "8789"
    private var appSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LLM Agent Learning Boost", isDirectory: true)
    }
    private var defaultConfigURL: URL { appSupport.appendingPathComponent("config.env") }
    private var configPointerURL: URL { appSupport.appendingPathComponent("config-path.txt") }
    private var configURL: URL { selectedConfigURL() }
    private var agentURL: URL { Bundle.main.resourceURL!.appendingPathComponent("agent", isDirectory: true) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        ensureConfig()
        repairDefaultConfigIfPossible()
        configureNotifications()
        installStatusItem()
        makeWindow()
        startServer()
        runStartupChecks()
        loadAppWhenReady()
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        notificationPollTimer?.invalidate()
        closeNativeSnap()
        terminateServerProcess()
    }

    private func makeWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "snap")
        configuration.userContentController.add(self, name: "learningNotification")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.loadHTMLString(statusHTML("Starting LLM Agent Learning Boost", "Starting the local wiki server..."), baseURL: nil)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LLM Agent Learning Boost"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "snap" {
            guard let text = body["text"] as? String else { return }
            let html = body["html"] as? String
            let bodySize = body["size"] as? Double
            let storedSize = UserDefaults.standard.double(forKey: snapSizeKey)
            showNativeSnap(text: text, html: html, size: CGFloat(bodySize ?? (storedSize > 0 ? storedSize : 34)))
            return
        }
        if message.name == "learningNotification" {
            handleLearningNotificationMessage(body)
        }
    }

    private func configureNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        DispatchQueue.main.async {
            self.notificationPollTimer?.invalidate()
            self.notificationPollTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                self?.pollLearningNotifications()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.pollLearningNotifications()
            }
        }
    }

    private func handleLearningNotificationMessage(_ body: [String: Any]) {
        let action = body["action"] as? String ?? "notify"
        if action == "requestPermission" {
            requestNotificationAuthorizationIfNeeded { status, error in
                let label = self.authorizationStatusLabel(status)
                if let error {
                    self.reportNativeNotificationStatus(
                        status: error.hasPrefix("permission_denied") ? "permission_denied" : label,
                        message: error
                    )
                } else {
                    self.reportNativeNotificationStatus(status: label, message: "macOS notification permission is \(label).")
                    self.pollLearningNotifications()
                }
            }
            return
        }
        if action == "pollNow" {
            pollLearningNotifications()
            return
        }
        let title = body["title"] as? String ?? "Learning Boost"
        let message = body["body"] as? String ?? body["message"] as? String ?? "Learning Boost needs attention."
        postLearningNotification(id: body["id"] as? String, title: title, body: message) { error in
            if let error {
                self.reportNativeNotificationStatus(status: error.hasPrefix("permission_denied") ? "permission_denied" : "failed", message: error)
            } else {
                self.reportNativeNotificationStatus(status: "delivered", message: "macOS accepted the notification.")
            }
        }
    }

    private func pollLearningNotifications() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/learning/notifications?pendingNative=1&limit=8") else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.timeoutInterval = 4
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let notifications = json["notifications"] as? [[String: Any]] else { return }
            if notifications.isEmpty { return }
            self.requestNotificationAuthorizationIfNeeded { _, authorizationError in
                if let authorizationError {
                    let action = authorizationError.hasPrefix("permission_denied") ? "permission_denied" : "native_failed"
                    for item in notifications {
                        guard let id = item["id"] as? String,
                              let vault = item["vault"] as? String else { continue }
                        self.markLearningNotification(vault: vault, id: id, action: action, nativeError: authorizationError)
                    }
                    self.reportNativeNotificationStatus(
                        status: action == "permission_denied" ? "permission_denied" : "failed",
                        message: authorizationError
                    )
                    return
                }
                for item in notifications {
                    guard let id = item["id"] as? String,
                          let vault = item["vault"] as? String else { continue }
                    let title = item["title"] as? String ?? "Learning Boost"
                    let body = item["body"] as? String ?? item["detail"] as? String ?? "Learning Boost needs attention."
                    self.deliverLearningNotification(id: id, title: title, body: body) { error in
                        if let error {
                            let action = error.hasPrefix("permission_denied") ? "permission_denied" : "native_failed"
                            self.markLearningNotification(vault: vault, id: id, action: action, nativeError: error)
                            self.reportNativeNotificationStatus(status: action == "permission_denied" ? "permission_denied" : "failed", message: error)
                        } else {
                            self.markLearningNotification(vault: vault, id: id, action: "delivered")
                            self.reportNativeNotificationStatus(status: "delivered", message: "macOS accepted the notification.")
                        }
                    }
                }
            }
        }.resume()
    }

    private func postLearningNotification(id: String?, title: String, body: String, completion: @escaping (String?) -> Void) {
        requestNotificationAuthorizationIfNeeded { _, error in
            if let error {
                completion(error)
                return
            }
            self.deliverLearningNotification(id: id, title: title, body: body, completion: completion)
        }
    }

    private func requestNotificationAuthorizationIfNeeded(completion: @escaping (UNAuthorizationStatus, String?) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            if self.isNotificationAuthorized(status) {
                completion(status, nil)
                return
            }
            if status == .denied {
                completion(status, "permission_denied: macOS notification authorization is denied.")
                return
            }
            if status != .notDetermined {
                completion(status, "native_failed: macOS notification authorization is \(self.authorizationStatusLabel(status)).")
                return
            }
            DispatchQueue.main.async {
                NSApp.activate(ignoringOtherApps: true)
                center.requestAuthorization(options: [.alert, .sound, .badge]) { _, requestError in
                    center.getNotificationSettings { updatedSettings in
                        let updatedStatus = updatedSettings.authorizationStatus
                        if let requestError {
                            completion(updatedStatus, "native_failed: \(requestError.localizedDescription)")
                            return
                        }
                        if self.isNotificationAuthorized(updatedStatus) {
                            completion(updatedStatus, nil)
                            return
                        }
                        if updatedStatus == .denied {
                            completion(updatedStatus, "permission_denied: macOS notification authorization is denied.")
                            return
                        }
                        completion(updatedStatus, "native_failed: macOS notification authorization is \(self.authorizationStatusLabel(updatedStatus)).")
                    }
                }
            }
        }
    }

    private func isNotificationAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional
    }

    private func deliverLearningNotification(id: String?, title: String, body: String, completion: @escaping (String?) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: id ?? "learning-boost-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            completion(error?.localizedDescription)
        }
    }

    private func markLearningNotification(vault: String, id: String, action: String, nativeError: String = "") {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/learning/notification-action") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 4
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "vault": vault,
            "id": id,
            "action": action,
            "nativeError": nativeError
        ])
        URLSession.shared.dataTask(with: request).resume()
    }

    private func authorizationStatusLabel(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "not_determined"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .provisional:
            return "provisional"
        @unknown default:
            return "unknown"
        }
    }

    private func reportNativeNotificationStatus(status: String, message: String = "") {
        let payload: [String: Any] = ["status": status, "message": message]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('learning-native-notification-status', { detail: \(json) }));", completionHandler: nil)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if #available(macOS 11.0, *) {
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = makeStatusItemIcon()
        statusItem.button?.toolTip = "LLM Agent Learning Boost"
        let menu = NSMenu()
        menu.addItem(menuItem("Show App", #selector(showApp), "s"))
        menu.addItem(menuItem("Open Config", #selector(openConfig), ","))
        menu.addItem(menuItem("Choose Config File...", #selector(chooseConfigFile), ""))
        menu.addItem(menuItem("Open Vaults Folder", #selector(openVaults), "v"))
        menu.addItem(NSMenuItem.separator())
        startAtLoginItem = menuItem("Start at Login", #selector(toggleLoginItem), "")
        dockIconItem = menuItem("Show Dock Icon", #selector(toggleDockIcon), "")
        closeBehaviorItem = menuItem("Close Button Keeps Running", #selector(toggleCloseBehavior), "")
        setupAlertItem = menuItem("Hide Setup Required on Startup", #selector(toggleSetupAlert), "")
        menu.addItem(startAtLoginItem)
        menu.addItem(dockIconItem)
        menu.addItem(closeBehaviorItem)
        menu.addItem(setupAlertItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem("Quit", #selector(quit), "q"))
        statusItem.menu = menu
        updateMenuStates()
        installMainMenu()
    }

    private func makeStatusItemIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()

        NSColor.black.setStroke()
        NSColor.black.setFill()

        let card = NSBezierPath(roundedRect: NSRect(x: 4.0, y: 3.0, width: 9.5, height: 12.0), xRadius: 2.0, yRadius: 2.0)
        card.lineWidth = 1.5
        card.stroke()

        let topLine = NSBezierPath()
        topLine.lineWidth = 1.2
        topLine.lineCapStyle = .round
        topLine.move(to: NSPoint(x: 6.2, y: 11.8))
        topLine.line(to: NSPoint(x: 10.6, y: 11.8))
        topLine.stroke()

        let boost = NSBezierPath()
        boost.lineWidth = 1.6
        boost.lineCapStyle = .round
        boost.lineJoinStyle = .round
        boost.move(to: NSPoint(x: 6.0, y: 6.0))
        boost.curve(to: NSPoint(x: 13.6, y: 9.5), controlPoint1: NSPoint(x: 8.0, y: 8.7), controlPoint2: NSPoint(x: 10.6, y: 9.6))
        boost.line(to: NSPoint(x: 12.1, y: 10.9))
        boost.move(to: NSPoint(x: 13.6, y: 9.5))
        boost.line(to: NSPoint(x: 12.1, y: 8.1))
        boost.stroke()

        let marker = NSBezierPath(ovalIn: NSRect(x: 3.0, y: 2.4, width: 3.4, height: 3.4))
        marker.fill()

        image.unlockFocus()
        image.isTemplate = true
        image.accessibilityDescription = "LLM Agent Learning Boost"
        return image
    }

    private func menuItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(menuItem("Quit LLM Agent Learning Boost", #selector(quit), "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "V"))
        editMenu.addItem(NSMenuItem(title: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: ""))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let windowMenuItem = NSMenuItem()
        windowMenu = NSMenu(title: "Window")
        windowMenu.delegate = self
        rebuildWindowMenu()
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = mainMenu
    }

    func menuWillOpen(_ menu: NSMenu) {
        if menu === windowMenu {
            rebuildWindowMenu()
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeButtonKeepsRunning {
            sender.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
            return false
        }
        NSApp.terminate(nil)
        return false
    }

    @objc private func showApp() {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateMenuStates()
    }

    @objc private func openConfig() {
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([configURL], withApplicationAt: textEdit, configuration: configuration) { _, error in
            if let error {
                DispatchQueue.main.async {
                    self.showAlert("Open Config", "Could not open config.env in TextEdit: \(error.localizedDescription)\n\nConfig path:\n\(self.configURL.path)")
                }
            }
        }
    }

    @objc private func chooseConfigFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose LLM Agent Learning Boost Config"
        panel.prompt = "Use Config"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = configURL.deletingLastPathComponent()
        panel.begin { response in
            guard response == .OK, let selected = panel.url else { return }
            self.setSelectedConfigURL(selected)
            self.ensureConfig()
            self.repairDefaultConfigIfPossible()
            self.restartServerAndReload()
            self.showAlert("Config File Updated", "The app is now using:\n\(selected.path)")
        }
    }

    @objc private func openVaults() {
        let root = readConfigValue("VAULTS_ROOT") ?? "~/Documents/Obsidian-Vaults"
        NSWorkspace.shared.open(URL(fileURLWithPath: expandTilde(root)))
    }

    @objc private func toggleLoginItem() {
        if #available(macOS 13.0, *) {
            do {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                } else {
                    try SMAppService.mainApp.register()
                }
                updateMenuStates()
                if SMAppService.mainApp.status == .requiresApproval {
                    showAlert("Start at Login", "macOS requires approval in System Settings -> General -> Login Items.")
                }
            } catch {
                showAlert("Start at Login", "Could not update login item: \(error.localizedDescription)")
            }
        } else {
            showAlert("Start at Login", "Start at Login requires macOS 13 or later in this build.")
        }
    }

    @objc private func toggleDockIcon() {
        let next: NSApplication.ActivationPolicy = NSApp.activationPolicy() == .regular ? .accessory : .regular
        NSApp.setActivationPolicy(next)
        if next == .regular { showApp() }
        updateMenuStates()
    }

    @objc private func toggleCloseBehavior() {
        UserDefaults.standard.set(!closeButtonKeepsRunning, forKey: closeBehaviorKey)
        updateMenuStates()
    }

    @objc private func toggleSetupAlert() {
        UserDefaults.standard.set(!hideSetupRequiredOnStartup, forKey: hideSetupAlertKey)
        updateMenuStates()
    }

    @objc private func closeWindowCommand() {
        DispatchQueue.main.async {
            self.closeActiveWindow()
        }
    }

    @objc private func openNewAppWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "snap")
        let secondaryWebView = WKWebView(frame: .zero, configuration: configuration)
        secondaryWebView.navigationDelegate = self
        secondaryWebView.uiDelegate = self
        secondaryWebView.loadHTMLString(statusHTML("Opening LLM Agent Learning Boost", "Loading the local wiki server..."), baseURL: nil)

        let secondaryWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        secondaryWindow.title = "LLM Agent Learning Boost"
        secondaryWindow.isReleasedWhenClosed = false
        secondaryWindow.center()
        secondaryWindow.contentView = secondaryWebView
        secondaryWindow.makeKeyAndOrderFront(nil)
        childWindows.append(secondaryWindow)

        if serverProcess?.isRunning != true {
            startServer()
        }
        loadAppWhenReady(in: secondaryWebView)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        updateMenuStates()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func rebuildWindowMenu() {
        guard let windowMenu else { return }
        windowMenu.removeAllItems()
        windowMenu.addItem(menuItem("New App Window", #selector(openNewAppWindow), "n"))
        windowMenu.addItem(menuItem("Close Active Window", #selector(closeWindowCommand), "w"))
        windowMenu.addItem(NSMenuItem.separator())

        let visibleWindows = appWindows()
        if visibleWindows.isEmpty {
            let item = NSMenuItem(title: "No displayed app windows", action: nil, keyEquivalent: "")
            item.isEnabled = false
            windowMenu.addItem(item)
        } else {
            for (index, appWindow) in visibleWindows.enumerated() {
                let title = "\(index + 1). \(windowTitle(appWindow))"
                let item = menuItem(title, #selector(focusWindowFromMenu(_:)), "")
                item.representedObject = appWindow.windowNumber
                item.state = appWindow === activeAppWindow() ? .on : .off
                windowMenu.addItem(item)
            }
        }

        windowMenu.addItem(NSMenuItem.separator())
        addScreenMoveItems(to: windowMenu)
    }

    private func addScreenMoveItems(to menu: NSMenu) {
        let screens = NSScreen.screens
        let active = activeAppWindow()
        if screens.count > 1, let active {
            let header = NSMenuItem(title: "Move Active Window To", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for (index, screen) in screens.enumerated() {
                if active.screen === screen { continue }
                let item = menuItem(screenName(screen, index: index), #selector(moveActiveWindowToScreen(_:)), "")
                item.representedObject = index
                menu.addItem(item)
            }
            if mirroredDisplayDetected {
                let note = NSMenuItem(title: "Screen mirroring detected", action: nil, keyEquivalent: "")
                note.isEnabled = false
                menu.addItem(note)
            }
        } else {
            let title = mirroredDisplayDetected
                ? "Screen mirroring detected; no separate move target"
                : "No other screen detected"
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
    }

    private func appWindows() -> [NSWindow] {
        childWindows = childWindows.filter { $0.isVisible }
        var result: [NSWindow] = []
        if let window, window.isVisible {
            result.append(window)
        }
        result.append(contentsOf: childWindows.filter { $0.isVisible && $0 !== window })
        return result
    }

    private func activeAppWindow() -> NSWindow? {
        let visibleWindows = appWindows()
        if let key = NSApp.keyWindow, visibleWindows.contains(where: { $0 === key }) {
            return key
        }
        if let main = NSApp.mainWindow, visibleWindows.contains(where: { $0 === main }) {
            return main
        }
        return visibleWindows.last
    }

    private func closeActiveWindow() {
        guard let active = activeAppWindow() else { return }
        if active === window {
            if closeButtonKeepsRunning {
                active.orderOut(nil)
                if appWindows().isEmpty {
                    NSApp.setActivationPolicy(.accessory)
                }
            } else {
                NSApp.terminate(nil)
            }
        } else {
            active.orderOut(nil)
            childWindows.removeAll { $0 === active || !$0.isVisible }
        }
        DispatchQueue.main.async {
            self.rebuildWindowMenu()
            self.updateMenuStates()
        }
    }

    @objc private func focusWindowFromMenu(_ sender: NSMenuItem) {
        guard let number = sender.representedObject as? Int,
              let target = appWindows().first(where: { $0.windowNumber == number }) else { return }
        NSApp.setActivationPolicy(.regular)
        target.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateMenuStates()
    }

    @objc private func moveActiveWindowToScreen(_ sender: NSMenuItem) {
        guard let index = sender.representedObject as? Int,
              NSScreen.screens.indices.contains(index),
              let active = activeAppWindow() else { return }
        move(active, to: NSScreen.screens[index])
    }

    private func move(_ targetWindow: NSWindow, to screen: NSScreen) {
        let visible = screen.visibleFrame
        var frame = targetWindow.frame
        frame.size.width = min(frame.width, visible.width - 40)
        frame.size.height = min(frame.height, visible.height - 40)
        frame.origin.x = visible.midX - frame.width / 2
        frame.origin.y = visible.midY - frame.height / 2
        targetWindow.setFrame(frame, display: true, animate: true)
        targetWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func windowTitle(_ targetWindow: NSWindow) -> String {
        if targetWindow === window {
            return "Main App Window"
        }
        return targetWindow.title.isEmpty ? "App Window" : targetWindow.title
    }

    private func screenName(_ screen: NSScreen, index: Int) -> String {
        "\(index + 1). \(screen.localizedName)"
    }

    private var mirroredDisplayDetected: Bool {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return false }
        var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success else { return false }
        return displays.contains { CGDisplayIsInMirrorSet($0) != 0 || CGDisplayIsInHWMirrorSet($0) != 0 }
    }

    private func ensureConfig() {
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: configURL.path) {
            let bundled = Bundle.main.resourceURL!.appendingPathComponent("config.example.env")
            if FileManager.default.fileExists(atPath: bundled.path) {
                try? FileManager.default.copyItem(at: bundled, to: configURL)
            }
        }
    }

    private func selectedConfigURL() -> URL {
        if let pointer = try? String(contentsOf: configPointerURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !pointer.isEmpty {
            UserDefaults.standard.set(pointer, forKey: configPathKey)
            return URL(fileURLWithPath: expandTilde(pointer))
        }
        if let stored = UserDefaults.standard.string(forKey: configPathKey), !stored.isEmpty {
            return URL(fileURLWithPath: expandTilde(stored))
        }
        return defaultConfigURL
    }

    private func setSelectedConfigURL(_ url: URL) {
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        UserDefaults.standard.set(url.path, forKey: configPathKey)
        try? "\(url.path)\n".write(to: configPointerURL, atomically: true, encoding: .utf8)
    }

    private func repairDefaultConfigIfPossible() {
        guard var text = try? String(contentsOf: configURL, encoding: .utf8) else { return }
        let currentRoot = readConfigValue("VAULTS_ROOT") ?? ""
        let expanded = expandTilde(currentRoot)
        let isPlaceholder = currentRoot.isEmpty || currentRoot == "~/Documents/Obsidian-Vaults" || !hasAnyVault(in: expanded)
        guard isPlaceholder, let detected = detectVaultsRoot() else { return }
        if text.contains("VAULTS_ROOT=") {
            text = text.replacingOccurrences(of: #"(?m)^VAULTS_ROOT=.*$"#, with: "VAULTS_ROOT=\(detected)", options: .regularExpression)
        } else {
            text += "\nVAULTS_ROOT=\(detected)\n"
        }
        try? text.write(to: configURL, atomically: true, encoding: .utf8)
    }

    private func detectVaultsRoot() -> String? {
        let candidates = [
            "\(NSHomeDirectory())/Library/Mobile Documents/com~apple~CloudDocs/Obsidian-Vaults",
            "\(NSHomeDirectory())/Documents/Obsidian-Vaults",
            "\(NSHomeDirectory())/Obsidian-Vaults"
        ]
        return candidates.first { hasAnyVault(in: $0) }
    }

    private func hasAnyVault(in root: String) -> Bool {
        guard !root.isEmpty, let items = try? FileManager.default.contentsOfDirectory(atPath: root) else { return false }
        return items.contains { name in
            let path = "\(root)/\(name)"
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return false }
            return name.hasSuffix("-vault") ||
                FileManager.default.fileExists(atPath: "\(path)/.obsidian") ||
                FileManager.default.fileExists(atPath: "\(path)/AGENTS.md")
        }
    }

    private var closeButtonKeepsRunning: Bool {
        if UserDefaults.standard.object(forKey: closeBehaviorKey) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: closeBehaviorKey)
    }

    private var hideSetupRequiredOnStartup: Bool {
        UserDefaults.standard.bool(forKey: hideSetupAlertKey)
    }

    private func updateMenuStates() {
        closeBehaviorItem?.state = closeButtonKeepsRunning ? .on : .off
        setupAlertItem?.state = hideSetupRequiredOnStartup ? .on : .off
        dockIconItem?.state = NSApp.activationPolicy() == .regular ? .on : .off
        if #available(macOS 13.0, *) {
            switch SMAppService.mainApp.status {
            case .enabled:
                startAtLoginItem?.state = .on
                startAtLoginItem?.title = "Start at Login"
            case .requiresApproval:
                startAtLoginItem?.state = .mixed
                startAtLoginItem?.title = "Start at Login (Needs Approval)"
            default:
                startAtLoginItem?.state = .off
                startAtLoginItem?.title = "Start at Login"
            }
        } else {
            startAtLoginItem?.state = .off
        }
    }

    private func startServer() {
        stopServerOnConfiguredPort()
        let process = Process()
        process.currentDirectoryURL = agentURL
        process.executableURL = nodeExecutableURL()
        process.arguments = ["node", "src/server.mjs"]
        if process.executableURL?.lastPathComponent == "node" {
            process.arguments = ["src/server.mjs"]
        }
        var env = ProcessInfo.processInfo.environment
        env["LLM_WIKI_ENV_FILE"] = configURL.path
        env["LEARNING_BOOST_TIME_ZONE"] = env["LEARNING_BOOST_TIME_ZONE"] ?? "America/Regina"
        env["TZ"] = env["TZ"] ?? "America/Regina"
        env["PATH"] = expandedPath()
        process.environment = env
        process.terminationHandler = { [weak self, weak process] terminatedProcess in
            DispatchQueue.main.async {
                guard let self else { return }
                if let finishedProcess = process, self.serverProcess === finishedProcess {
                    self.serverProcess = nil
                }
                guard !self.isTerminating else { return }
                guard terminatedProcess.terminationStatus != 0 else { return }
                guard self.serverRestartAttempts < 2 else { return }
                self.serverRestartAttempts += 1
                self.startServer()
                self.loadAppWhenReady()
            }
        }
        serverProcess = process
        do {
            try process.run()
            serverRestartAttempts = 0
        } catch {
            showAlert("Node.js required", "Install Node.js, then restart LLM Agent Learning Boost.\n\nThe app checks /opt/homebrew/bin/node, /usr/local/bin/node, and PATH.\n\nError: \(error.localizedDescription)")
        }
    }

    private func restartServerAndReload() {
        terminateServerProcess()
        startServer()
        loadAppWhenReady()
    }

    private func loadAppWhenReady(attempt: Int = 1) {
        loadAppWhenReady(in: webView, attempt: attempt)
    }

    private func loadAppWhenReady(in targetWebView: WKWebView, attempt: Int = 1) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
        guard let appURL = URL(string: "http://127.0.0.1:\(port)/?v=\(version)&window=\(UUID().uuidString)"),
              let statusURL = URL(string: "http://127.0.0.1:\(port)/api/status") else { return }
        var statusRequest = URLRequest(url: statusURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        statusRequest.timeoutInterval = 8
        URLSession.shared.dataTask(with: statusRequest) { data, response, error in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 && !(data?.isEmpty ?? true)
            DispatchQueue.main.async {
                if ok {
                    var appRequest = URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
                    appRequest.timeoutInterval = 45
                    self.navigationRetryCounts[ObjectIdentifier(targetWebView)] = 0
                    targetWebView.load(appRequest)
                } else if attempt < 90 {
                    targetWebView.loadHTMLString(self.statusHTML("Starting LLM Agent Learning Boost", "Waiting for the local server... attempt \(attempt)/90"), baseURL: nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.loadAppWhenReady(in: targetWebView, attempt: attempt + 1)
                    }
                } else {
                    let detail = error?.localizedDescription ?? "The local server did not return a page."
                    targetWebView.loadHTMLString(self.statusHTML("Could not load the app", "\(detail)<br><br>Use the menu bar icon -> Open Config to check configuration, or click Retry."), baseURL: nil)
                }
            }
        }.resume()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationRetryCounts[ObjectIdentifier(webView)] = 0
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        let retryableCodes = [
            NSURLErrorTimedOut,
            NSURLErrorCannotConnectToHost,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet
        ]
        let key = ObjectIdentifier(webView)
        let retryCount = navigationRetryCounts[key] ?? 0
        if nsError.domain == NSURLErrorDomain && retryableCodes.contains(nsError.code) && retryCount < 8 {
            navigationRetryCounts[key] = retryCount + 1
            webView.loadHTMLString(statusHTML("Reconnecting LLM Agent Learning Boost", "\(error.localizedDescription)<br><br>Retrying..."), baseURL: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self.loadAppWhenReady(in: webView)
            }
            return
        }
        webView.loadHTMLString(statusHTML("Could not load the app", "\(error.localizedDescription)<br><br>Click Retry after checking the menu bar config."), baseURL: nil)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let childWebView = WKWebView(frame: .zero, configuration: configuration)
        childWebView.navigationDelegate = self
        childWebView.uiDelegate = self
        let childWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        childWindow.title = "LLM Agent Learning Boost"
        childWindow.isReleasedWhenClosed = false
        childWindow.center()
        childWindow.contentView = childWebView
        childWindow.makeKeyAndOrderFront(nil)
        childWindows.append(childWindow)
        return childWebView
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "LLM Agent Learning Boost"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "LLM Agent Learning Boost"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.informativeText = ""
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Attach note media"
        panel.prompt = "Attach"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [
            .image,
            .pdf,
            .audio,
            .movie,
            .mpeg4Movie,
            .quickTimeMovie
        ]
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    private func showNativeSnap(text: String, html: String?, size: CGFloat) {
        closeNativeSnap()
        let borderColor = randomSparkColor()
        for (index, screen) in NSScreen.screens.enumerated() {
            let overlay = NSWindow(
                contentRect: screen.frame,
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            overlay.level = .screenSaver
            overlay.backgroundColor = NSColor.black.withAlphaComponent(0.88)
            overlay.isOpaque = false
            overlay.isReleasedWhenClosed = false
            overlay.ignoresMouseEvents = index != 0
            overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            overlay.contentView = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
            if index == 0 {
                addSnapBox(to: overlay, text: text, html: html, size: size, borderColor: borderColor)
            }
            overlay.makeKeyAndOrderFront(nil)
            snapWindows.append(overlay)
        }
    }

    private func addSnapBox(to window: NSWindow, text: String, html: String?, size: CGFloat, borderColor: NSColor) {
        guard let content = window.contentView else { return }
        let margin: CGFloat = 50
        let maxWidth = content.bounds.width - margin * 2
        let maxHeight = content.bounds.height - margin * 2
        let minWidth: CGFloat = min(460, maxWidth)
        let minHeight: CGFloat = min(220, maxHeight)
        let horizontalPadding: CGFloat = 72
        let verticalPadding: CGFloat = 132
        let textSize = measuredSnapTextSize(text: text, fontSize: size, maxWidth: maxWidth - horizontalPadding)
        let width = min(maxWidth, max(minWidth, textSize.width + horizontalPadding))
        let height = min(maxHeight, max(minHeight, textSize.height + verticalPadding))
        let box = NSView(frame: NSRect(x: (content.bounds.width - width) / 2, y: (content.bounds.height - height) / 2, width: width, height: height))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor(red: 0.02, green: 0.03, blue: 0.06, alpha: 1).cgColor
        box.layer?.borderWidth = 3
        box.layer?.borderColor = borderColor.cgColor
        box.layer?.cornerRadius = 10
        box.layer?.shadowColor = borderColor.cgColor
        box.layer?.shadowOpacity = 0.85
        box.layer?.shadowRadius = 28
        box.layer?.shadowOffset = .zero

        let controls = NSView(frame: NSRect(x: 18, y: height - 62, width: width - 36, height: 44))
        controls.wantsLayer = true
        controls.layer?.backgroundColor = NSColor(red: 0.10, green: 0.13, blue: 0.18, alpha: 1).cgColor
        controls.layer?.cornerRadius = 8
        box.addSubview(controls)

        let close = NSButton(title: "Close", target: self, action: #selector(closeNativeSnapAction))
        close.bezelStyle = .rounded
        close.frame = NSRect(x: controls.bounds.width - 88, y: 7, width: 72, height: 30)
        controls.addSubview(close)

        let slider = NSSlider(value: Double(size), minValue: 24, maxValue: 84, target: self, action: #selector(snapSliderChanged(_:)))
        slider.frame = NSRect(x: 84, y: 10, width: min(320, controls.bounds.width - 204), height: 24)
        controls.addSubview(slider)
        let label = NSTextField(labelWithString: "Size")
        label.textColor = NSColor(calibratedWhite: 0.86, alpha: 1)
        label.frame = NSRect(x: 18, y: 12, width: 48, height: 20)
        controls.addSubview(label)

        let webConfiguration = WKWebViewConfiguration()
        let textView = WKWebView(frame: NSRect(x: 28, y: 28, width: width - 56, height: height - 112), configuration: webConfiguration)
        textView.setValue(false, forKey: "drawsBackground")
        textView.loadHTMLString(snapHTMLDocument(text: text, html: html, size: size), baseURL: nil)
        box.addSubview(textView)
        snapTextView = textView
        snapBoxView = box
        content.addSubview(box)
        startSnapSparkle(on: box)
    }

    @objc private func snapSliderChanged(_ sender: NSSlider) {
        let size = CGFloat(sender.doubleValue)
        UserDefaults.standard.set(Double(size), forKey: snapSizeKey)
        snapTextView?.evaluateJavaScript("document.documentElement.style.setProperty('--snap-font-size', '\(Int(size))px')")
    }

    @objc private func closeNativeSnapAction() {
        closeNativeSnap()
    }

    private func closeNativeSnap() {
        snapWindows.forEach {
            $0.orderOut(nil)
            $0.close()
        }
        snapWindows = []
        snapBoxView = nil
        snapTextView = nil
    }

    private func snapHTMLDocument(text: String, html: String?, size: CGFloat) -> String {
        let body = (html?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? html!
            : escapeHTML(text)
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            :root { --snap-font-size: \(Int(size))px; }
            html, body { margin: 0; padding: 0; background: transparent; color: #f8fbff; }
            body {
              box-sizing: border-box;
              padding: 10px;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              font-size: var(--snap-font-size);
              line-height: 1.35;
              font-weight: 750;
              letter-spacing: 0;
              overflow-wrap: anywhere;
              white-space: normal;
            }
            p, ul, ol { margin-top: 0; }
            ul, ol { padding-inline-start: 1.4em; padding-inline-end: 0; list-style-position: outside; }
            li { overflow-wrap: anywhere; }
            li.qa-question { margin-top: 0.75em; padding-top: 0.55em; border-top: 1px solid rgba(248, 251, 255, 0.22); }
            li.qa-question:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
            li.qa-answer { margin-top: 0.25em; margin-inline-start: 1.2em; }
            [dir="rtl"] ul, [dir="rtl"] ol, [data-align="right"] ul, [data-align="right"] ol { padding-inline-start: 0; padding-inline-end: 1.4em; }
            .note-indicator, .note-popover { display: none !important; }
            mark { background: transparent; color: inherit; }
          </style>
        </head>
        <body>\(body)</body>
        </html>
        """
    }

    private func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "\n", with: "<br>")
    }

    private func measuredSnapTextSize(text: String, fontSize: CGFloat, maxWidth: CGFloat) -> CGSize {
        let font = NSFont.systemFont(ofSize: fontSize, weight: .bold)
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        let rect = (text as NSString).boundingRect(
            with: NSSize(width: max(260, maxWidth), height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes
        )
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }

    private func startSnapSparkle(on view: NSView) {
        let opacity = CABasicAnimation(keyPath: "shadowOpacity")
        opacity.fromValue = 0.55
        opacity.toValue = 1.0
        opacity.duration = 0.42
        opacity.autoreverses = true
        opacity.repeatCount = .infinity
        opacity.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        view.layer?.add(opacity, forKey: "snapShadowOpacity")

        let radius = CABasicAnimation(keyPath: "shadowRadius")
        radius.fromValue = 18
        radius.toValue = 48
        radius.duration = 0.42
        radius.autoreverses = true
        radius.repeatCount = .infinity
        radius.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        view.layer?.add(radius, forKey: "snapShadowRadius")

        let border = CABasicAnimation(keyPath: "borderWidth")
        border.fromValue = 2.5
        border.toValue = 5.5
        border.duration = 0.42
        border.autoreverses = true
        border.repeatCount = .infinity
        border.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        view.layer?.add(border, forKey: "snapBorderWidth")
    }

    private func randomSparkColor() -> NSColor {
        let colors: [NSColor] = [
            NSColor.systemCyan,
            NSColor.systemBlue,
            NSColor.systemPurple,
            NSColor.systemPink,
            NSColor.systemYellow,
            NSColor.white
        ]
        return colors.randomElement() ?? .systemCyan
    }

    private func statusHTML(_ title: String, _ message: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { margin: 0; font: 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #18202b; }
            main { max-width: 680px; margin: 80px auto; padding: 0 28px; line-height: 1.5; }
            h1 { font-size: 24px; margin: 0 0 12px; }
            p { margin: 0; color: #4b5563; }
            button { margin-top: 22px; border: 0; border-radius: 8px; padding: 10px 16px; background: #111827; color: white; font: inherit; cursor: pointer; }
            button:hover { background: #374151; }
          </style>
        </head>
        <body><main><h1>\(title)</h1><p>\(message)</p><button onclick="location.href='http://127.0.0.1:\(port)/?retry=' + Date.now()">Retry</button></main></body>
        </html>
        """
    }

    private func nodeExecutableURL() -> URL {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return URL(fileURLWithPath: "/usr/bin/env")
    }

    private func expandedPath() -> String {
        let existing = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        return "/opt/homebrew/bin:/usr/local/bin:\(existing)"
    }

    private func stopServerOnConfiguredPort() {
        let output = runQuick(["lsof", "-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"])
        for line in output.split(separator: "\n") {
            let pid = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
            if !pid.isEmpty && pid != String(ProcessInfo.processInfo.processIdentifier) {
                terminateChildren(of: pid)
                _ = runQuick(["kill", pid])
            }
        }
    }

    private func terminateServerProcess() {
        guard let process = serverProcess else { return }
        let pid = String(process.processIdentifier)
        terminateChildren(of: pid)
        process.terminate()
        serverProcess = nil
    }

    private func terminateChildren(of pid: String) {
        guard !pid.isEmpty else { return }
        _ = runQuick(["pkill", "-TERM", "-P", pid])
    }

    private func runStartupChecks() {
        var problems: [String] = []
        if !FileManager.default.fileExists(atPath: "/Applications/Obsidian.app") &&
            !FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/Applications/Obsidian.app") {
            problems.append("Install Obsidian from https://obsidian.md and create/configure at least one vault.")
        }
        if !detectClipper() {
            problems.append("Install Obsidian Web Clipper from https://obsidian.md/clipper.")
        }
        let vaultRoot = expandTilde(readConfigValue("VAULTS_ROOT") ?? "")
        if (vaultRoot.isEmpty || !hasConfiguredVault(in: vaultRoot)) && !hasAnyRegisteredObsidianVault() {
            problems.append("Open or add at least one vault in Obsidian, or set VAULTS_ROOT in config.env to a folder containing Obsidian vaults. The app creates AGENTS.md, CLAUDE.md, index.md, log.md, raw/, and wiki/ automatically.")
        }
        if !providerConfigured() {
            problems.append("Configure at least one AI provider in config.env. For ChatGPT subscription mode, install Codex CLI and run `codex login`.")
        }
        if !problems.isEmpty && !hideSetupRequiredOnStartup {
            showSetupRequiredAlert(problems.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n\n"))
        }
    }

    private func detectClipper() -> Bool {
        let home = NSHomeDirectory()
        let chromiumId = "cnjifjpddelmedmihgijeibhnjfabmlf"
        let edgeId = "eigdjhmgnaaeaonimdklocfekkaanfme"
        let candidates = [
            "\(home)/Library/Application Support/Google/Chrome/Default/Extensions/\(chromiumId)",
            "\(home)/Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions/\(chromiumId)",
            "\(home)/Library/Application Support/Microsoft Edge/Default/Extensions/\(edgeId)",
            "/Applications/Obsidian Web Clipper.app",
            "\(home)/Applications/Obsidian Web Clipper.app"
        ]
        return candidates.contains { FileManager.default.fileExists(atPath: $0) }
    }

    private func hasConfiguredVault(in root: String) -> Bool {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: root) else { return false }
        return items.contains { name in
            let path = "\(root)/\(name)"
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return false }
            return name.hasSuffix("-vault") ||
                FileManager.default.fileExists(atPath: "\(path)/.obsidian") ||
                FileManager.default.fileExists(atPath: "\(path)/AGENTS.md") ||
                FileManager.default.fileExists(atPath: "\(path)/CLAUDE.md")
        }
    }

    private func hasAnyRegisteredObsidianVault() -> Bool {
        let registryPath = "\(NSHomeDirectory())/Library/Application Support/obsidian/obsidian.json"
        guard
            let data = FileManager.default.contents(atPath: registryPath),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let vaults = json["vaults"] as? [String: Any]
        else {
            return false
        }
        return vaults.values.contains { entry in
            if let path = entry as? String {
                return isExistingDirectory(expandTilde(path))
            }
            if let dict = entry as? [String: Any], let path = dict["path"] as? String {
                return isExistingDirectory(expandTilde(path))
            }
            return false
        }
    }

    private func isExistingDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    private func providerConfigured() -> Bool {
        let provider = readConfigValue("DEFAULT_AI_PROVIDER") ?? ""
        if provider == "local_auto" {
            return true
        }
        if provider == "openai_subscription" {
            return runQuick(["codex", "login", "status"]).lowercased().contains("logged in")
        }
        let keyNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY", "GEMINI_API_KEY", "GEMINI_OAUTH_ACCESS_TOKEN"]
        return keyNames.contains { key in
            guard let value = readConfigValue(key) else { return false }
            return !value.isEmpty && !value.hasPrefix("replace-with-")
        }
    }

    private func readConfigValue(_ key: String) -> String? {
        guard let text = try? String(contentsOf: configURL, encoding: .utf8) else { return nil }
        return text.split(separator: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("#"), let eq = trimmed.firstIndex(of: "=") else { return nil }
            return String(trimmed[..<eq]) == key ? String(trimmed[trimmed.index(after: eq)...]).trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) : nil
        }.first
    }

    private func runQuick(_ args: [String]) -> String {
        let p = Process()
        let pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = expandedPath()
        p.environment = env
        p.standardOutput = pipe
        p.standardError = pipe
        try? p.run()
        p.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    private func expandTilde(_ path: String) -> String {
        path.replacingOccurrences(of: "~", with: NSHomeDirectory())
    }

    private func showAlert(_ title: String, _ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.runModal()
        }
    }

    private func showSetupRequiredAlert(_ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "Setup required"
            alert.informativeText = "\(message)\n\nYou can change this later from the menu bar icon."
            alert.alertStyle = .warning
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Do not show this setup message on startup"
            alert.runModal()
            if alert.suppressionButton?.state == .on {
                UserDefaults.standard.set(true, forKey: self.hideSetupAlertKey)
                self.updateMenuStates()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
