import SwiftUI
import MailflareKit

/// The results of a search in place of the list: first the mail on this device, then what only
/// the server has.
struct SearchResultsView: View {
	let model: SearchModel
	let session: AccountSession
	@Environment(ComposeCoordinator.self) private var composer

	var body: some View {
		List {
			if !model.onDevice.isEmpty {
				Section("On this device") { rows(model.onDevice) }
			}
			Section {
				rows(model.onServer)
				serverNote
			} header: {
				if !model.onServer.isEmpty { Text("Older mail on the server") }
			}
		}
		.listStyle(.plain)
		.overlay {
			if model.isEmpty && (model.serverState == .done || model.serverState == .failed) { ContentUnavailableView.search(text: model.text) }
		}
		.task {
			// A message read or moved from the results changes what the device holds.
			for await _ in session.store.observeList(ListScope(folder: .all), limit: 1) { model.refreshLocal() }
		}
	}

	private func rows(_ items: [ListItem]) -> some View {
		ForEach(items) { item in
			Group {
				if item.message.status == "draft" {
					Button { composer.intent = .serverDraft(id: item.id) } label: { MessageRowView(item: item, showsThread: false) }
						.buttonStyle(.plain)
				} else {
					NavigationLink(value: Route.message(item.id)) { MessageRowView(item: item, showsThread: false) }
						.navigationLinkIndicatorVisibility(.hidden)
				}
			}
			.listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 12))
		}
	}

	@ViewBuilder private var serverNote: some View {
		Group {
			switch model.serverState {
			case .searching:
				HStack(spacing: 8) { ProgressView(); Text("Searching the server…") }
			case .needsNetwork:
				Label("Without a connection only the mail on this device is searched.", systemImage: "wifi.slash")
			case .failed:
				Label("The server could not be searched.", systemImage: "exclamationmark.triangle")
			case .idle, .done:
				EmptyView()
			}
		}
		.font(.footnote)
		.foregroundStyle(.secondary)
		.frame(maxWidth: .infinity)
		.listRowSeparator(.hidden)
	}
}
