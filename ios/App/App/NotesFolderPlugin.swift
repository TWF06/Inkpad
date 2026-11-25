import Foundation
import UIKit
import WebKit
import UniformTypeIdentifiers
import Capacitor

/**
 * The notes folder on the iPad: the iOS side of the "NotesFolder" plugin (the Android side is NotesFolderPlugin.java,
 * with the same methods and results, so the web app works the same on both).
 *
 * The user picks a folder once (iCloud Drive, On My iPad, or a file provider) and iOS gives the app a bookmark that
 * keeps working after restarts. "Keep them inside the app" uses the app's own Documents folder, which the Files app
 * also shows, under On My iPad › Inkpad.
 *
 * Also: files opened with Inkpad from other apps, the share sheet, and printing / saving as PDF.
 */
@objc(NotesFolderPlugin)
public class NotesFolderPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "NotesFolderPlugin"
    public let jsName = "NotesFolder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "useAppFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyToCache", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeShared", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)
    ]

    private let bookmarkKey = "inkpad.notesFolderBookmark"
    private let modeKey = "inkpad.notesFolderMode"   // "folder" (picked) or "app" (the app's Documents folder)
    private let appFolderName = "On My iPad › Inkpad"
    private let maxDepth = 6
    private let maxEntries = 5000

    private let fm = FileManager.default
    private let lock = NSLock()
    private var accessed: URL?            // the picked folder, opened for access once per run
    private var pickCall: CAPPluginCall?  // waiting for the folder chooser
    private var shared: [[String: Any]] = []   // copies of files opened with Inkpad, waiting for the web side
    private var printJob: PrintJob?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(openedURL(_:)), name: .capacitorOpenURL, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // ---------- the folder ----------

    private var defaults: UserDefaults { UserDefaults.standard }

    private func appFolder() -> URL? {
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        try? fm.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs
    }

    /** The notes folder, if it can be used: the app's own folder, or the picked one (opened for access). */
    private func folder() -> URL? {
        if defaults.string(forKey: modeKey) == "app" { return appFolder() }
        lock.lock(); defer { lock.unlock() }
        if let a = accessed { return a }
        guard let data = defaults.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        guard url.startAccessingSecurityScopedResource() else { return nil }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            defaults.set(fresh, forKey: bookmarkKey)
        }
        accessed = url
        return url
    }

    private func releaseFolder() {
        lock.lock(); defer { lock.unlock() }
        accessed?.stopAccessingSecurityScopedResource()
        accessed = nil
    }

    private func isDir(_ url: URL) -> Bool {
        var d: ObjCBool = false
        return fm.fileExists(atPath: url.path, isDirectory: &d) && d.boolValue
    }

    private func displayName(_ url: URL) -> String {
        if defaults.string(forKey: modeKey) == "app" { return appFolderName }
        return fm.displayName(atPath: url.path)
    }

    @objc func current(_ call: CAPPluginCall) {
        guard let f = folder(), isDir(f) else { return call.resolve(["connected": false]) }
        call.resolve(["connected": true, "name": displayName(f), "app": defaults.string(forKey: modeKey) == "app"])
    }

    /** useAppFolder() — keep notes in the app's own Documents folder (Files app: On My iPad › Inkpad). */
    @objc func useAppFolder(_ call: CAPPluginCall) {
        releaseFolder()
        defaults.set("app", forKey: modeKey)
        guard appFolder() != nil else { return call.reject("No app folder") }
        call.resolve(["name": appFolderName])
    }

    @objc func pick(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { return call.reject("No window to show the folder chooser in") }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            picker.directoryURL = self.appFolder()
            self.pickCall = call
            vc.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first, url.startAccessingSecurityScopedResource() else {
            return call.reject("iPadOS did not allow access to that folder")
        }
        do {
            let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            releaseFolder()
            defaults.set(bookmark, forKey: bookmarkKey)
            defaults.set("folder", forKey: modeKey)
            lock.lock(); accessed = url; lock.unlock()
            call.resolve(["picked": true, "name": fm.displayName(atPath: url.path)])
        } catch {
            url.stopAccessingSecurityScopedResource()
            call.reject("Could not keep access to that folder", nil, error)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.resolve(["picked": false])
        pickCall = nil
    }

    // ---------- files in the folder ----------

    private func requireFolder(_ call: CAPPluginCall) -> URL? {
        guard let f = folder() else { call.reject("No notes folder", "NO_FOLDER"); return nil }
        return f
    }

    private static func dirOf(_ path: String) -> String {
        guard let i = path.lastIndex(of: "/") else { return "" }
        return String(path[..<i])
    }
    private static func nameOf(_ path: String) -> String {
        guard let i = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: i)...])
    }
    private static func joinPath(_ dir: String, _ name: String) -> String { dir.isEmpty ? name : dir + "/" + name }

    /** The URL of `path` inside the notes folder; nil for paths that try to leave it. */
    private func resolve(_ root: URL, _ path: String) -> URL? {
        var url = root
        for part in path.split(separator: "/") {
            if part == ".." || part == "." { return nil }
            url.appendPathComponent(String(part))
        }
        return url
    }

    private func info(_ url: URL, _ path: String) -> [String: Any] {
        var o: [String: Any] = ["name": Self.nameOf(path), "path": path]
        var u = url
        u.removeAllCachedResourceValues()
        if let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]) {
            if let d = v.contentModificationDate { o["lastModified"] = Int64(d.timeIntervalSince1970 * 1000) }
            if let s = v.fileSize { o["size"] = s }
        }
        return o
    }

    // iCloud Drive keeps files that aren't on the iPad yet as hidden ".name.icloud" placeholders: fetch them, so they
    // show up on the next look at the folder
    private func fetchIfInCloud(_ dir: URL, _ name: String) {
        guard name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > 8 else { return }
        let real = String(name.dropFirst().dropLast(".icloud".count))
        try? fm.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(real))
    }

    private func walk(_ dir: URL, _ prefix: String, _ depth: Int, _ files: inout [[String: Any]], _ dirs: inout [[String: Any]], _ count: inout Int) {
        let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey, .fileSizeKey]
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: []) else { return }
        var sub: [(URL, String)] = []
        for item in items {
            if count >= maxEntries { break }
            let name = item.lastPathComponent
            if name.hasPrefix(".") { fetchIfInCloud(dir, name); continue }   // hidden files and folders
            let path = prefix + name
            count += 1
            let v = try? item.resourceValues(forKeys: Set(keys))
            if v?.isDirectory == true {
                dirs.append(["path": path, "name": name])
                sub.append((item, path))
            } else {
                var o: [String: Any] = ["path": path, "name": name]
                if let d = v?.contentModificationDate { o["lastModified"] = Int64(d.timeIntervalSince1970 * 1000) }
                o["size"] = v?.fileSize ?? 0
                files.append(o)
            }
        }
        if depth >= maxDepth { return }
        for (url, path) in sub { walk(url, path + "/", depth + 1, &files, &dirs, &count) }
    }

    /** list() -> { files: [{path, name, lastModified, size}], dirs: [{path, name}] }, subfolders included. */
    @objc func list(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        var files: [[String: Any]] = [], dirs: [[String: Any]] = [], count = 0
        walk(root, "", 0, &files, &dirs, &count)
        call.resolve(["files": files, "dirs": dirs])
    }

    // Reads and writes are coordinated, so iCloud Drive and other file providers see consistent files.
    private func readData(_ url: URL) throws -> Data {
        var coordErr: NSError?
        var result: Result<Data, Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { u in
            result = Result { try Data(contentsOf: u) }
        }
        if let e = coordErr { throw e }
        return try result.get()
    }

    private func writeData(_ data: Data, _ url: URL) throws {
        var coordErr: NSError?
        var failure: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordErr) { u in
            // .atomic: written to a temporary file first and swapped in, so a crash never leaves half a note
            do { try data.write(to: u, options: .atomic) } catch { failure = error }
        }
        if let e = coordErr ?? failure { throw e }
    }

    @objc func read(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        let name = call.getString("name", "")
        guard let url = resolve(root, name), fm.fileExists(atPath: url.path), !isDir(url) else {
            return call.reject("Not found: \(name)", "NOT_FOUND")
        }
        do {
            let data = try readData(url)
            call.resolve(["data": String(decoding: data, as: UTF8.self)])
        } catch {
            call.reject("Could not read \(name)", nil, error)
        }
    }

    private func save(_ call: CAPPluginCall, base64: Bool) {
        guard let root = requireFolder(call) else { return }
        let name = call.getString("name", "")
        let text = call.getString("data", "")
        guard let url = resolve(root, name), !Self.nameOf(name).isEmpty else { return call.reject("Bad file name: \(name)") }
        guard isDir(url.deletingLastPathComponent()) else { return call.reject("Could not save \(name): the folder \(Self.dirOf(name)) is gone") }
        let data: Data
        if base64 {
            guard let d = Data(base64Encoded: text, options: .ignoreUnknownCharacters) else { return call.reject("Could not save \(name): bad data") }
            data = d
        } else {
            data = Data(text.utf8)
        }
        do {
            try writeData(data, url)
            call.resolve(info(url, name))
        } catch {
            call.reject("Could not save \(name)", nil, error)
        }
    }

    /** write({ name, data, encoding?: 'utf8' | 'base64', mime? }) — creates or replaces the file. */
    @objc func write(_ call: CAPPluginCall) { save(call, base64: call.getString("encoding", "utf8") == "base64") }

    /** replace({ name, data (base64), mime }) — replaces a file safely (written aside first, then swapped in). */
    @objc func replace(_ call: CAPPluginCall) { save(call, base64: true) }

    /** move({ name, to }) — rename and/or move a file to another folder inside the notes folder. */
    @objc func move(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        let name = call.getString("name", ""), to = call.getString("to", "")
        guard let src = resolve(root, name), let dst = resolve(root, to), !Self.nameOf(to).isEmpty else { return call.reject("Bad file name") }
        guard fm.fileExists(atPath: src.path) else { return call.reject("Could not move \(name): not found") }
        guard isDir(dst.deletingLastPathComponent()) else { return call.reject("Could not move \(name): folder not found") }
        do {
            let caseOnly = src.path != dst.path && src.path.lowercased() == dst.path.lowercased()
            if !caseOnly && fm.fileExists(atPath: dst.path) { return call.reject("Could not move \(name): \(to) already exists") }
            var coordErr: NSError?
            var failure: Error?
            NSFileCoordinator().coordinate(writingItemAt: src, options: .forMoving, writingItemAt: dst, options: .forReplacing, error: &coordErr) { a, b in
                do {
                    if caseOnly {
                        // a name that only changes case: go through a temporary name, or the file system says it exists
                        let tmp = a.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).inkpad-tmp")
                        try self.fm.moveItem(at: a, to: tmp)
                        try self.fm.moveItem(at: tmp, to: b)
                    } else {
                        try self.fm.moveItem(at: a, to: b)
                    }
                    NSFileCoordinator().item(at: a, didMoveTo: b)
                } catch { failure = error }
            }
            if let e = coordErr ?? failure { throw e }
            call.resolve(info(dst, to))
        } catch {
            call.reject("Could not move \(name)", nil, error)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        guard let url = resolve(root, call.getString("name", "")) else { return call.resolve() }
        do {
            if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            call.resolve()
        } catch {
            call.reject("Could not delete", nil, error)
        }
    }

    /**
     * trash({ names: [...] }) — move files to Recently Deleted (Files app), where they can be restored for 30 days.
     * Rejects with code "UNSUPPORTED" when this place has no Recently Deleted; the files are left as they were then.
     */
    @objc func trash(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        let names = call.getArray("names", String.self) ?? []
        var done = 0
        for name in names {
            guard let url = resolve(root, name), fm.fileExists(atPath: url.path) else { continue }   // already gone
            do {
                try fm.trashItem(at: url, resultingItemURL: nil)
                done += 1
            } catch {
                if done == 0 { return call.reject("No Recently Deleted here", "UNSUPPORTED", error) }
                return call.reject("Some files could not be moved to Recently Deleted", "UNSUPPORTED", error)
            }
        }
        call.resolve(["trashed": true])
    }

    // ---------- reading files into the app ----------

    private func mimeOf(_ name: String) -> String {
        let ext = (name as NSString).pathExtension
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }

    /** Copy a file into the app's cache so the web side can read it (Capacitor.convertFileSrc). */
    private func toCache(_ data: Data, _ name: String) throws -> [String: Any] {
        let dir = fm.temporaryDirectory.appendingPathComponent("shared", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        // the web side reads each copy straight away: older copies are no longer needed
        let cutoff = Date().addingTimeInterval(-120)
        for old in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let d = try? old.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, d < cutoff { try? fm.removeItem(at: old) }
        }
        let safe = name.replacingOccurrences(of: "/", with: "_")
        let f = dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(safe)")
        try data.write(to: f)
        return ["path": f.path, "name": name, "mime": mimeOf(name)]
    }

    /** copyToCache({ name }) — a PDF or picture in the notes folder, ready to be opened. */
    @objc func copyToCache(_ call: CAPPluginCall) {
        guard let root = requireFolder(call) else { return }
        let name = call.getString("name", "")
        guard let url = resolve(root, name), fm.fileExists(atPath: url.path) else { return call.reject("Not found: \(name)", "NOT_FOUND") }
        do { call.resolve(try toCache(try readData(url), Self.nameOf(name))) }
        catch { call.reject("Could not open \(name)", nil, error) }
    }

    /** A PDF or picture opened with Inkpad (Files app, share sheet "Open in Inkpad"): keep a copy for the web side. */
    @objc private func openedURL(_ n: Notification) {
        guard let o = n.object as? [String: Any], let url = o["url"] as? URL, url.isFileURL else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? readData(url), let copy = try? toCache(data, url.lastPathComponent) else { return }
        lock.lock(); shared.append(copy); lock.unlock()
        // files handed over through the share sheet land in the app's Inbox: the copy is enough
        if url.path.contains("/Documents/Inbox/") { try? fm.removeItem(at: url) }
        notifyListeners("shared", data: [:])
    }

    /** takeShared() -> { files: [{path, name, mime}] } — files opened with Inkpad since the last call. */
    @objc func takeShared(_ call: CAPPluginCall) {
        lock.lock(); let files = shared; shared.removeAll(); lock.unlock()
        call.resolve(["files": files])
    }

    // ---------- share ----------

    /** Where a popover (share sheet, print options) points from: the middle of the screen. iPads need one. */
    private func anchor(_ popover: UIPopoverPresentationController?, _ view: UIView) {
        guard let p = popover else { return }
        p.sourceView = view
        p.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        p.permittedArrowDirections = []
    }

    /**
     * share({ name?, data?, filename, mime }) — the share sheet (AirDrop, Mail, Messages, Save to Files…) for a file in
     * the notes folder (name = its path there) or bytes from the web side (data, base64).
     */
    @objc func share(_ call: CAPPluginCall) {
        var filename = call.getString("filename", "Inkpad")
            .components(separatedBy: CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        if filename.isEmpty || filename.allSatisfy({ $0 == "." }) { filename = "Inkpad" }
        do {
            let outbox = fm.temporaryDirectory.appendingPathComponent("outbox", isDirectory: true)
            let cutoff = Date().addingTimeInterval(-600)   // earlier shares: the receiving app has had its copy by now
            for old in (try? fm.contentsOfDirectory(at: outbox, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
                if let d = try? old.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, d < cutoff { try? fm.removeItem(at: old) }
            }
            // its own folder, so the receiver sees the real file name
            let dir = outbox.appendingPathComponent(String(Int(Date().timeIntervalSince1970 * 1000)), isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let f = dir.appendingPathComponent(filename)
            if let name = call.getString("name") {
                guard let root = requireFolder(call) else { return }
                guard let src = resolve(root, name), fm.fileExists(atPath: src.path) else { return call.reject("Not found: \(name)", "NOT_FOUND") }
                try readData(src).write(to: f)
            } else {
                guard let d = Data(base64Encoded: call.getString("data", ""), options: .ignoreUnknownCharacters) else { return call.reject("Bad data") }
                try d.write(to: f)
            }
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else { return call.reject("Nothing can share this file") }
                let sheet = UIActivityViewController(activityItems: [f], applicationActivities: nil)
                self.anchor(sheet.popoverPresentationController, vc.view)
                vc.present(sheet, animated: true) { call.resolve() }
            }
        } catch {
            call.reject("Could not share \(filename)", nil, error)
        }
    }

    // ---------- print / save as PDF ----------

    /** print({ html, title }) — the print sheet (AirPrint; also "Save to Files" as a PDF from its share button). */
    @objc func print(_ call: CAPPluginCall) {
        let html = call.getString("html", "")
        let title = call.getString("title", "Inkpad")
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { return call.reject("Printing isn’t available") }
            self.printJob = PrintJob(html: html) { [weak self] web in
                let pc = UIPrintInteractionController.shared
                let info = UIPrintInfo.printInfo()
                info.outputType = .general
                info.jobName = title
                pc.printInfo = info
                pc.printFormatter = web.viewPrintFormatter()
                let done: UIPrintInteractionController.CompletionHandler = { _, _, _ in self?.printJob = nil }
                if UIDevice.current.userInterfaceIdiom == .pad {
                    let r = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                    pc.present(from: r, in: vc.view, animated: true, completionHandler: done)
                } else {
                    pc.present(animated: true, completionHandler: done)
                }
                call.resolve()
            }
        }
    }
}

/** Loads the pages to print in a web view of their own; hands it over once everything (pictures too) has loaded. */
private class PrintJob: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let ready: (WKWebView) -> Void

    init(html: String, ready: @escaping (WKWebView) -> Void) {
        // the pages are plain pictures: no script runs in this view
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 794, height: 1123), configuration: config)
        self.ready = ready
        super.init()
        web.navigationDelegate = self
        web.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready(webView) }
}
