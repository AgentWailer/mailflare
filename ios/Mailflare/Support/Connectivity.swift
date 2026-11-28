import Foundation
import Network
import Synchronization

/// Whether the device is on Wi-Fi, which decides if attachments are fetched unasked.
nonisolated final class Connectivity: Sendable {
	static let shared = Connectivity()

	private let monitor = NWPathMonitor()
	private let state = Mutex(false)

	private init() {
		monitor.pathUpdateHandler = { [weak self] path in
			let wifi = path.status == .satisfied && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)) && !path.isExpensive
			self?.state.withLock { $0 = wifi }
		}
		monitor.start(queue: DispatchQueue(label: "de.steffenvonlindern.mailflare.connectivity"))
	}

	var isOnWiFi: Bool { state.withLock { $0 } }
}
