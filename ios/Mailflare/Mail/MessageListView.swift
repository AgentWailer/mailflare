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
		MessageListContent(scope: scope, session: session, showsCategories: showsCategories)
			.id(scope)
			// The categories belong to the screen, not to one list: they stay where the user
			// scrolled them while the list underneath is swapped.
			.safeAreaInset(edge: .top, spacing: 0) {
				if showsCategories {
					CategoryBar(selection: $scope.folder).background(.bar)
				}
			}
			.onChange(of: scope, initial: true) { _, scope in
				// Remember the list so the app opens on it the next time.
				if let json = try? JSONEncoder().encode(scope) { try? session.store.setSetting(SettingKey.lastScope, String(decoding: json, as: UTF8.self)) }
			}
	}
}

private struct MessageListContent: View {
	let session: AccountSession
	let showsCategories: Bool
	@State private var model: MessageListModel
	@AppStorage("list.conversations") private var conversations = true
	@State private var prompts = ActionPrompts()
	@State private var tree = MailboxTree()
	@State private var selection = Set<String>()
	@State private var editMode: EditMode = .inactive
	@Environment(ComposeCoordinator.self) private var composer
	private let words = Presentation.current

	private var isSelecting: Bool { editMode == .active }

	private func run(_ action: RowAction, on item: ListItem) {
		prompts.run(action, on: [item.id], mailboxId: item.message.mailboxId) { await model.perform($0, on: $1) }
	}

	/// What the selected rows have in common: the offers of the first, kept to what all may do.
	private var selectionOffer: [RowAction] {
		let rows = model.items.filter { selection.contains($0.id) }
		guard let first = rows.first else { return [] }
		let canManage = rows.allSatisfy { MailActions.canManage(mailboxId: $0.message.mailboxId, in: tree) }
		let offer = MailActions.offered(for: first.message, canManage: canManage)
		return Array((offer.leading + offer.trailing).filter { $0 != .snooze && $0 != .unsnooze }.prefix(4))
	}

	private func runOnSelection(_ action: RowAction) {
		let ids = model.items.map(\.id).filter(selection.contains)
		let mailboxId = model.items.first { selection.contains($0.id) }?.message.mailboxId
		prompts.run(action, on: ids, mailboxId: mailboxId) { await model.perform($0, on: $1) }
		if action != .move && action != .deletePermanently { endSelecting() }
	}

	private func endSelecting() {
		selection = []
		withAnimation { editMode = .inactive }
	}

	init(scope: ListScope, session: AccountSession, showsCategories: Bool) {
		self.session = session
		self.showsCategories = showsCategories
		_model = State(initialValue: MessageListModel(scope: scope, session: session))
	}

	private var title: String {
		if let folderId = model.scope.folderId, let folder = (try? session.store.mailboxTree())?.folders.first(where: { $0.id == folderId }) { return folder.name }
		return words.name(of: showsCategories ? .inbox : model.scope.folder)
	}

	var body: some View {
		// Rows are only selectable while selecting; otherwise a row that was opened would stay highlighted.
		List(selection: isSelecting ? $selection : .constant([])) {
			ForEach(model.items) { item in
				let offer = MailActions.offered(for: item.message, canManage: MailActions.canManage(mailboxId: item.message.mailboxId, in: tree))
				Group {
					if item.message.status == "draft" {
						// A draft is opened to go on writing, not to be read.
						Button { composer.intent = .serverDraft(id: item.id) } label: { MessageRowView(item: item, showsThread: false) }
							.buttonStyle(.plain)
					} else {
						NavigationLink(value: Route.message(item.id)) {
							MessageRowView(item: item, showsThread: model.conversations)
						}
						.navigationLinkIndicatorVisibility(.hidden)
					}
				}
				.listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 12))
				.swipeActions(edge: .leading, allowsFullSwipe: true) {
					ForEach(offer.leading, id: \.self) { action in
						RowActionButton(action: action) { run(action, on: item) }.tint(action.tint)
					}
				}
				.swipeActions(edge: .trailing, allowsFullSwipe: true) {
					ForEach(offer.trailing, id: \.self) { action in
						RowActionButton(action: action) { run(action, on: item) }.tint(action.tint)
					}
				}
				.contextMenu {
					ForEach(offer.menu, id: \.self) { action in
						RowActionButton(action: action) { run(action, on: item) }
					}
				}
			}
			footer
		}
		.listStyle(.plain)
		.environment(\.editMode, $editMode)
		.actionPrompts(prompts, tree: tree, onDone: endSelecting) { await model.perform($0, on: $1) }
		.overlay {
			if model.hasLoaded && model.items.isEmpty { emptyState }
		}
		.navigationTitle(title)
		// A large title would sit under the row of categories and be blurred away by it.
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				if isSelecting {
					Button("Done") { endSelecting() }
				} else if !model.items.isEmpty {
					Button("Select") { withAnimation { editMode = .active } }
				}
			}
			if isSelecting {
				ToolbarItemGroup(placement: .bottomBar) {
					ForEach(selectionOffer, id: \.self) { action in
						RowActionButton(action: action) { runOnSelection(action) }
							.disabled(selection.isEmpty)
						if action != selectionOffer.last { Spacer() }
					}
				}
			}
			ToolbarItem(placement: .bottomBar) {
				if !isSelecting {
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
			}
			ToolbarItem(placement: .status) {
				if !isSelecting { SyncStatusLabel(status: model.status) }
			}
			ToolbarItem(placement: .bottomBar) {
				if !isSelecting {
					Button { composer.intent = .new() } label: { Label("New message", systemImage: "square.and.pencil") }
				}
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
		.task {
			for await tree in session.store.observeMailboxes() { self.tree = tree }
		}
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
		ScrollViewReader { proxy in
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
					.id(folder)
				}
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 8)
		}
		// A chip chosen at the edge of the screen moves fully into view.
		.onChange(of: selection, initial: true) { _, folder in
			withAnimation { proxy.scrollTo(folder, anchor: .center) }
		}
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
