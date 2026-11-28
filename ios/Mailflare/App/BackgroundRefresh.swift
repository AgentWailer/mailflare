import BackgroundTasks

/// Asks iOS to wake the app now and then so new mail is already there when it is opened.
/// iOS decides when, and whether at all; this is a courtesy, not a schedule.
nonisolated enum BackgroundRefresh {
	static let identifier = "de.steffenvonlindern.mailflare.refresh"

	static func schedule() {
		let request = BGAppRefreshTaskRequest(identifier: identifier)
		request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
		try? BGTaskScheduler.shared.submit(request)
	}
}
