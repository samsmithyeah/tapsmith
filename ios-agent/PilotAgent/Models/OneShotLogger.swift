import Foundation

/// Thread-safe logger that fires at most once per instance. Used to surface
/// degradation from KVC/reflection failures without spamming the log on
/// every snapshot or element conversion.
final class OneShotLogger {
    private let lock = NSLock()
    private var fired = false

    var hasFired: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fired
    }

    func log(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !fired else { return }
        fired = true
        NSLog("%@", message)
    }
}
