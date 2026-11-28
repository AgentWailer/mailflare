import SwiftUI
import MailflareKit

/// A list of mail. In the inbox a row of categories sits above it, and choosing one swaps the list.
struct MessageListView: View {
	let session: AccountSession
	@State private var scope: ListScope
	private let showsCategories: Bool

	init(scope: ListScope, session: AccountSession) {
		self.session = session
		_scope = State(initialValue: scope)
		showsCategories = scope.folder.isCategory && scope.folderId == nil
	}

	var body: some View {
		MessageListContent(scope: scope, session: session, categories: showsCategories ? $scope.folder : nil)
			.id(scope)
			.onChange(of: scope, initial: true) { _, scope in
				// Remember the list so the app opens on it the next time.
				if let json = try? JSONEncoder().encode(scope) { try? session.store.setSetting(SettingKey.lastScope, String(decoding: json, as: UTF8.self)) }
			}
	}
}

private struct MessageListContent: View {
	let session: AccountSession
	let categories: Binding<SystemFolder>?
	@State private var model: MessageListModel
	@AppStorage("list.conversations") private var conversations = true
	private let words = Presentation.current

	init(scope: ListScope, session: AccountSession, categories: Binding<SystemFolder>?) {
		self.session = session
		self.categories = categories
		_model = State(initialValue: MessageListModel(scope: scope, session: session))
	}

	private var title: String {
		if let folderId = model.scope.folderId, let folder = (try? session.store.mailboxTree())?.folders.first(where: { $0.id == folderId }) { return folder.name }
		return words.name(of: categories == nil ? model.scope.folder : .inbox)
	}

	var body: some View {
		List {
			if let categories {
				CategoryBar(selection: categories)
					.listRowInsets(EdgeInsets())
					.listRowSeparator(.hidden)
			}
			ForEach(model.items) { item in
				NavigationLink(value: Route.message(item.id)) {
					MessageRowView(item: item, showsThread: model.conversations)
				}
				.listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 12))
			}
			footer
		}
		.listStyle(.plain)
		.overlay {
			if model.hasLoaded && model.items.isEmpty { emptyState }
		}
		.navigationTitle(title)
		.toolbar {
			ToolbarItem(placement: .bottomBar) {
				Menu {
					Picker("Show", selection: $model.unreadOnly) {
						Text("All").tag(false)
						Text("Unread").tag(true)
					}
					Toggle("Group conversations", isOn: $conversations)
				} label: {
					Label("Filter", systemImage: model.unreadOnly ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
				}
			}
			ToolbarItem(placement: .status) {
				SyncStatusLabel(status: model.status)
			}
		}
		.refreshable {
			Haptics.play(.impact)
			await model.refresh()
		}
		.onChange(of: conversations, initial: true) { _, value in model.conversations = value }
		.onChange(of: model.unreadOnly) { _, _ in Haptics.play(.selection) }
		.onAppear { model.start() }
		.onDisappear { model.stop() }
	}

	@ViewBuilder private var footer: some View {
		if !model.items.isEmpty {
			Group {
				switch model.olderState {
				case .idle, .loading:
					HStack { Spacer(); ProgressView(); Spacer() }
						.task(id: model.items.count) { await model.loadOlder() }
				case .needsNetwork:
					Label("Older mail loads when you are online again.", systemImage: "wifi.slash")
						.font(.footnote).foregroundStyle(.secondary)
						.frame(maxWidth: .infinity)
				case .end:
					EmptyView()
				}
			}
			.listRowSeparator(.hidden)
		}
	}

	@ViewBuilder private var emptyState: some View {
		if case .syncing(firstRun: true) = model.status {
			ContentUnavailableView { Label("Fetching your mail", systemImage: "arrow.down.circle") } description: { Text("The first sync brings the last days onto this device.") }
		} else if model.unreadOnly {
			ContentUnavailableView("Nothing unread", systemImage: "checkmark.circle")
		} else {
			ContentUnavailableView("No mail here", systemImage: Presentation.symbol(of: model.scope.folder))
		}
	}
}

/// The inbox and its categories as a row of chips.
struct CategoryBar: View {
	@Binding var selection: SystemFolder
	private let words = Presentation.current

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 8) {
				ForEach(SystemFolder.categories, id: \.self) { folder in
					let selected = folder == selection
					Button {
						guard !selected else { return }
						Haptics.play(.selection)
						selection = folder
					} label: {
						Text(words.categoryChip(folder))
							.font(.subheadline.weight(selected ? .semibold : .regular))
							.padding(.horizontal, 14)
							.padding(.vertical, 7)
							.background(selected ? Color.accentColor : Color(.secondarySystemFill), in: Capsule())
							.foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(selected ? .isSelected : [])
				}
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 8)
		}
	}
}

struct SyncStatusLabel: View {
	let status: SyncStatus

	private var isProblem: Bool {
		switch status {
		case .offline, .accessDenied, .signedOut, .failed: true
		case .idle, .syncing: false
		}
	}

	var body: some View {
		// The wording depends on the clock, so it is refreshed while it is on screen.
		TimelineView(.periodic(from: .now, by: 30)) { context in
			Text(Presentation.current.syncStatus(status, now: context.date))
				.font(.caption)
				.foregroundStyle(isProblem ? Color.orange : Color.secondary)
				.lineLimit(1)
		}
	}
}
