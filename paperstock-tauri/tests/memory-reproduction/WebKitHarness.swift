import AppKit
import WebKit
import Darwin

// Standalone WKWebView test host, never the installed Paperstock process.
// Private PID getter is diagnostic-only, to measure/terminate this host's renderer.
final class Harness: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webview: WKWebView!
    var timer: Timer?
    var peakFootprint: UInt64 = 0
    var terminated = false
    var intentionallyHidden = false
    let url = CommandLine.arguments[1]
    let output = CommandLine.arguments[2]
    let recovery = CommandLine.arguments.contains("--reload-on-termination")

    func emit(_ value: [String: Any]) {
        var data = value
        data["time"] = Date().timeIntervalSince1970
        if let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]),
           let string = String(data: encoded, encoding: .utf8) {
            print(string)
            fflush(stdout)
        }
    }

    func pid() -> Int32 {
        guard webview.responds(to: NSSelectorFromString("_webProcessIdentifier")),
              let number = webview.value(forKey: "_webProcessIdentifier") as? NSNumber else { return 0 }
        return number.int32Value
    }

    func sample(_ extra: [String: Any] = [:]) {
        var value = extra
        value["kind"] = value["kind"] ?? "memory"
        let renderer = pid()
        let footprint = renderer > 0 ? test_footprint(renderer) : 0
        peakFootprint = max(peakFootprint, footprint)
        value["rendererPid"] = renderer
        value["hostPid"] = getpid()
        value["physicalFootprintBytes"] = footprint
        value["residentBytes"] = renderer > 0 ? test_resident(renderer) : 0
        value["peakPhysicalFootprintBytes"] = peakFootprint
        value["windowVisible"] = window.isVisible
        value["windowOccluded"] = !window.occlusionState.contains(.visible)
        value["applicationHidden"] = NSApp.isHidden
        value["applicationActive"] = NSApp.isActive
        if !intentionallyHidden && !terminated && !window.occlusionState.contains(.visible) {
            window.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
        }
        emit(value)
        // Safety ceiling: do not reproduce macOS's multi-GB kill threshold.
        if footprint > 1_250_000_000 {
            emit(["kind": "safety-stop", "reason": "test renderer exceeded 1.25 GB footprint"])
            NSApp.terminate(nil)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "test")
        webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 850), configuration: configuration)
        webview.navigationDelegate = self
        window = NSWindow(contentRect: webview.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Paperstock isolated memory reproduction"
        // Avoid unrelated foreground windows occluding the RAF-driven test renderer.
        // Only our explicit orderOut() step should make this document hidden.
        window.level = .floating
        window.hidesOnDeactivate = false
        // Keep only this test window visible when the user works in another Space.
        // Never switch Spaces or move the user's existing windows for the test.
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = webview
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webview.load(URLRequest(url: URL(string: url)!))
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.sample() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 480) {
            self.emit(["kind": "timeout"])
            NSApp.terminate(nil)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = message.body as? [String: Any] else { return }
        sample(data)
        switch data["kind"] as? String {
        case "hide":
            intentionallyHidden = true
            window.orderOut(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                self.intentionallyHidden = false
                self.window.makeKeyAndOrderFront(nil)
                self.window.orderFrontRegardless()
                NSApp.activate(ignoringOtherApps: true)
                self.webview.evaluateJavaScript("window.testWasHidden = true")
            }
        case "snapshot":
            snapshot(String(describing: data["label"] ?? "snapshot"))
        case "terminate-renderer":
            let renderer = pid()
            guard renderer > 0, renderer != getpid() else { return }
            emit(["kind": "intentional-test-renderer-kill", "rendererPid": renderer])
            kill(renderer, SIGKILL)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.snapshot("after-termination")
                self.webview.evaluateJavaScript("({bodyLength:document.body?.innerHTML.length, title:document.title})") { result, error in
                    self.emit(["kind": "post-termination-js", "value": String(describing: result), "error": String(describing: error)])
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                self.emit(["kind": "host-survived-renderer-kill", "terminationDelegateCalled": self.terminated])
                NSApp.terminate(nil)
            }
        case "finish":
            NSApp.terminate(nil)
        default: break
        }
    }

    func snapshot(_ label: String) {
        webview.takeSnapshot(with: nil) { image, error in
            guard let image = image, let data = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else {
                self.emit(["kind": "snapshot-error", "label": label, "error": String(describing: error)])
                return
            }
            try? png.write(to: URL(fileURLWithPath: self.output + "/" + label + ".png"))
            self.emit(["kind": "snapshot-saved", "label": label])
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        terminated = true
        emit(["kind": "web-content-process-did-terminate", "reload": recovery])
        if recovery { webView.reload() }
    }
}

let app = NSApplication.shared
let delegate = Harness()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
