import Cocoa
import WebKit

class PanelWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func keyDown(with event: NSEvent) {
        // Forward Cmd+C/V/X/A to the responder chain so WKWebView handles clipboard
        if event.modifierFlags.contains(.command) {
            let ch = event.charactersIgnoringModifiers ?? ""
            if "cvxa".contains(ch) {
                if let responder = firstResponder {
                    responder.doCommand(by: [
                        "c": #selector(NSText.copy(_:)),
                        "v": #selector(NSText.paste(_:)),
                        "x": #selector(NSText.cut(_:)),
                        "a": #selector(NSText.selectAll(_:)),
                    ][ch]!)
                    return
                }
            }
        }
        super.keyDown(with: event)
    }
}

class DragHandle: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: PanelWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var rightCmdWasDown = false

    func voicePanelDir() -> String {
        return (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    }

    func isServerRunning() -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(3457).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    func ensureServer() {
        if isServerRunning() { return }

        let dir = voicePanelDir()

        // Install deps if needed
        let nodeModules = (dir as NSString).appendingPathComponent("node_modules")
        if !FileManager.default.fileExists(atPath: nodeModules) {
            let install = Process()
            install.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            install.arguments = ["npm", "install", "--silent"]
            install.currentDirectoryURL = URL(fileURLWithPath: dir)
            try? install.run()
            install.waitUntilExit()
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["npx", "tsx", "server.ts"]
        proc.currentDirectoryURL = URL(fileURLWithPath: dir)
        var env = ProcessInfo.processInfo.environment
        if let path = env["PATH"] {
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + path
        }
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        serverProcess = proc

        // Wait up to 5 seconds for server (PTY spawn needs time)
        for _ in 0..<50 {
            if isServerRunning() { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureServer()
        let width: CGFloat = 320
        let handleHeight: CGFloat = 24
        let screen = NSScreen.main!.frame
        let height = screen.height - 40
        let x = screen.maxX - width - 20
        let y: CGFloat = 20

        window = PanelWindow(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .resizable],
            backing: .buffered,
            defer: false
        )

        window.level = .floating
        window.isOpaque = false
        window.backgroundColor = NSColor(red: 0.102, green: 0.102, blue: 0.118, alpha: 0.95)
        window.hasShadow = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.minSize = NSSize(width: 240, height: 300)

        let content = window.contentView!
        content.wantsLayer = true
        content.layer?.cornerRadius = 12
        content.layer?.masksToBounds = true

        // Drag handle at top
        let handle = DragHandle(frame: NSRect(
            x: 0, y: height - handleHeight,
            width: width, height: handleHeight
        ))
        handle.wantsLayer = true
        handle.layer?.backgroundColor = NSColor(red: 0.133, green: 0.133, blue: 0.149, alpha: 1.0).cgColor
        handle.autoresizingMask = [.width, .minYMargin]

        // Pill indicator
        let pill = NSView(frame: NSRect(
            x: (width - 40) / 2, y: (handleHeight - 4) / 2,
            width: 40, height: 4
        ))
        pill.wantsLayer = true
        pill.layer?.backgroundColor = NSColor(white: 0.4, alpha: 1.0).cgColor
        pill.layer?.cornerRadius = 2
        pill.autoresizingMask = [.minXMargin, .maxXMargin]
        handle.addSubview(pill)

        // Close button
        let closeBtn = NSButton(frame: NSRect(x: 6, y: 2, width: 20, height: 20))
        closeBtn.bezelStyle = .inline
        closeBtn.isBordered = false
        closeBtn.title = "✕"
        closeBtn.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        closeBtn.contentTintColor = NSColor(white: 0.5, alpha: 1.0)
        closeBtn.target = self
        closeBtn.action = #selector(closePanel)
        handle.addSubview(closeBtn)

        // WebView below handle
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: NSRect(
            x: 0, y: 0,
            width: width, height: height - handleHeight
        ), configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.uiDelegate = self

        let url = URL(string: "http://localhost:3457")!
        webView.load(URLRequest(url: url))

        content.addSubview(webView)
        content.addSubview(handle)
        window.makeKeyAndOrderFront(nil)

        NSApp.setActivationPolicy(.regular)

        if let icon = Bundle.main.image(forResource: "AppIcon") {
            NSApp.applicationIconImage = icon
        }

        // Global hotkey: Right Cmd toggles recording (works from any app)
        NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleRightCmd(event)
        }
        NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleRightCmd(event)
            return event
        }
    }

    func handleRightCmd(_ event: NSEvent) {
        // keyCode 54 = Right Command
        guard event.keyCode == 54 else { return }
        let isDown = event.modifierFlags.contains(.command)
        if isDown && !rightCmdWasDown {
            rightCmdWasDown = true
            DispatchQueue.main.async {
                self.webView.evaluateJavaScript("window.toggleRecording && window.toggleRecording()")
            }
        } else if !isDown {
            rightCmdWasDown = false
        }
    }

    // Auto-grant microphone permission for localhost
    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    @objc func closePanel() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
