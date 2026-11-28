import SwiftUI
import MailflareKit

/// The root: the account, its mailboxes and folders with their unread counts, and the other areas.
struct MailboxListView: View {
	let session: AccountSession
	@Environment(AppModel.self) private var model
	@State private var tree = MailboxTree()
	@State private var waiting: [OutgoingMessage] = []
	@Environment(ComposeCoordinator.self) private var composer
	@AppStorage("list.conversations") private var conversations = true
	private let words = Presentation.current

	private static let folders: [SystemFolder] = [.inbox, .starred, .snoozed, .scheduled, .sent, .drafts, .archived, .spam, .trash, .all]

	private func scope(_ folder: SystemFolder, mailboxId: String? = nil, folderId: String? = nil) -> Route {
		.list(ListScope(mailboxId: mailboxId, folder: folder, folderId: folderId, conversations: conversations))
	}

	private func unread(_ folder: SystemFolder) -> Int {
		// Drafts and scheduled mail are counted whole: none of them is "unread".
		let count = tree.counts.folders[folder.rawValue]
		return [.drafts, .scheduled].contains(folder) ? count?.total ?? 0 : count?.unread ?? 0
	}

	var body: some View {
		List {
			if tree.mailboxes.count > 1 {
				Section("Mailboxes") {
					ForEach(tree.mailboxes) { mailbox in
						NavigationLink(value: scope(.inbox, mailboxId: mailbox.id)) {
							FolderRow(title: mailbox.displayName ?? mailbox.address, subtitle: mailbox.displayName == nil ? nil : mailbox.address,
							          symbol: mailbox.isShared ? "person.2.crop.square.stack" : "envelope",
							          count: tree.counts.mailboxes.first { $0.mailboxId == mailbox.id }?.unread ?? 0)
						}
					}
				}
			}
			if !waiting.isEmpty {
				Section {
					NavigationLink(value: Route.outbox) {
						FolderRow(title: Presentation.current.text("Outbox"), symbol: waiting.contains { $0.state.kind == .failed } ? "exclamationmark.circle" : "arrow.up.circle",
						          tint: waiting.contains { $0.state.kind == .failed } ? .red : nil, count: waiting.count)
					}
				}
			}
			Section(tree.mailboxes.count > 1 ? "All mailboxes" : "Mail") {
				ForEach(Self.folders, id: \.self) { folder in
					NavigationLink(value: scope(folder)) {
						FolderRow(title: words.name(of: folder), symbol: Presentation.symbol(of: folder), count: unread(folder))
					}
				}
			}
			if !tree.folders.isEmpty {
				Section("Folders") {
					ForEach(tree.folders) { folder in
						NavigationLink(value: scope(.inbox, mailboxId: folder.mailboxId, folderId: folder.id)) {
							FolderRow(title: folder.name, symbol: "folder", tint: Color(hex: folder.color), count: tree.counts.customFolders[folder.id]?.unread ?? 0)
						}
					}
				}
			}
			Section("More") {
				NavigationLink(value: Route.web(.calendar)) { Label("Calendar", systemImage: "calendar") }
				NavigationLink(value: Route.web(.drive)) { Label("Drive", systemImage: "externaldrive") }
				NavigationLink(value: Route.appSettings) { Label("Settings", systemImage: "gearshape") }
				if session.account.isAdmin {
					NavigationLink(value: Route.web(.admin)) { Label("Administration", systemImage: "wrench.and.screwdriver") }
				}
			}
		}
		.listStyle(.insetGrouped)
		.navigationTitle("Mailboxes")
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) { AccountSwitcher(session: session) }
			ToolbarItem(placement: .bottomBar) { Spacer() }
			ToolbarItem(placement: .bottomBar) {
				Button { composer.intent = .new() } label: { Label("New message", systemImage: "square.and.pencil") }
			}
		}
		.refreshable {
			Haptics.play(.impact)
			await session.engine.syncNow()
		}
		.task {
			for await tree in session.store.observeMailboxes() { self.tree = tree }
		}
		.task {
			for await waiting in session.store.observeOutgoing() { self.waiting = waiting }
		}
	}
}

struct FolderRow: View {
	let title: String
	var subtitle: String?
	let symbol: String
	var tint: Color?
	let count: Int

	var body: some View {
		HStack {
			Label {
				VStack(alignment: .leading, spacing: 2) {
					Text(title)
					if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
				}
			} icon: {
				Image(systemName: symbol).foregroundStyle(tint ?? Color.accentColor)
			}
			Spacer()
			if count > 0 {
				Text(count, format: .number).foregroundStyle(.secondary).monospacedDigit()
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(count > 0 ? Text("\(title), \(count) unread") : Text(title))
	}
}

/// The profile button: which account is in use, switching, adding and signing out.
struct AccountSwitcher: View {
	let session: AccountSession
	@Environment(AppModel.self) private var model

	var body: some View {
		Menu {
			Section(session.account.email) {
				ForEach(model.accounts.filter { $0.userId != session.account.userId }) { account in
					Button(account.email, systemImage: "person.crop.circle") {
						Haptics.play(.selection)
						Task { await model.switchAccount(userId: account.userId) }
					}
				}
				Button("Add account", systemImage: "plus") { model.beginAddingAccount() }
			}
		} label: {
			Text(initials(session.account.name.isEmpty ? session.account.email : session.account.name))
				.font(.footnote.bold())
				.foregroundStyle(.white)
				.frame(width: 30, height: 30)
				.background(Color.accentColor, in: Circle())
		}
		.accessibilityLabel(Text("Account: \(session.account.email)"))
	}
}

func initials(_ name: String) -> String {
	let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).prefix(2)
	let letters = words.compactMap(\.first).map(String.init).joined().uppercased()
	return letters.isEmpty ? "?" : letters
}

extension Color {
	/// A `#rrggbb` colour as the web stores it for folders. Nil when it is not one.
	init?(hex: String?) {
		guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
		self.init(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
	}
}
