import SwiftUI
import MailflareKit

/// The questions an action may still have to ask before it can happen.
@Observable
final class ActionPrompts {
	/// Rows waiting for a snooze time.
	var snoozing: [String]?
	/// Rows waiting for a folder, and the mailbox whose folders are offered.
	var moving: (ids: [String], mailboxId: String?)?
	/// Rows waiting for the user's word before they are deleted for good.
	var deleting: [String]?

	/// Carries an offer out, or asks first when it needs a time, a folder or a confirmation.
	func run(_ action: RowAction, on ids: [String], mailboxId: String?, perform: @escaping (MailAction, [String]) async -> Void) {
		switch action {
		case .snooze: snoozing = ids
		case .move: moving = (ids, mailboxId)
		case .deletePermanently: deleting = ids
		default:
			guard let mailAction = action.mailAction() else { return }
			Haptics.play(action.isDestructive ? .warning : .success)
			Task { await perform(mailAction, ids) }
		}
	}
}

/// Attaches the snooze choice, the folder picker and the delete confirmation to a screen.
struct ActionPromptsModifier: ViewModifier {
	@Bindable var prompts: ActionPrompts
	let tree: MailboxTree
	let perform: (MailAction, [String]) async -> Void
	var onDone: () -> Void = {}

	private func finish(_ action: MailAction, _ ids: [String]) {
		Haptics.play(.success)
		Task {
			await perform(action, ids)
			onDone()
		}
	}

	func body(content: Content) -> some View {
		content
			.confirmationDialog("Snooze until", isPresented: Binding(get: { prompts.snoozing != nil }, set: { if !$0 { prompts.snoozing = nil } }), titleVisibility: .visible) {
				ForEach(SnoozePreset.options()) { preset in
					Button {
						if let ids = prompts.snoozing { finish(.snooze(until: preset.date), ids) }
					} label: {
						Text(preset.title) + Text(verbatim: " · ") + Text(preset.date.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
					}
				}
			}
			.confirmationDialog("Delete for good?", isPresented: Binding(get: { prompts.deleting != nil }, set: { if !$0 { prompts.deleting = nil } }), titleVisibility: .visible) {
				Button("Delete for good", role: .destructive) {
					if let ids = prompts.deleting { finish(.deletePermanently, ids) }
				}
			} message: {
				Text("This cannot be undone.")
			}
			.sheet(isPresented: Binding(get: { prompts.moving != nil }, set: { if !$0 { prompts.moving = nil } })) {
				if let moving = prompts.moving {
					FolderPicker(folders: tree.folders.filter { $0.mailboxId == moving.mailboxId }) { target in
						prompts.moving = nil
						finish(target, moving.ids)
					}
				}
			}
	}
}

extension View {
	func actionPrompts(_ prompts: ActionPrompts, tree: MailboxTree, onDone: @escaping () -> Void = {}, perform: @escaping (MailAction, [String]) async -> Void) -> some View {
		modifier(ActionPromptsModifier(prompts: prompts, tree: tree, perform: perform, onDone: onDone))
	}
}

/// Where a message can be moved: the inbox, the archive, or one of the mailbox's own folders.
struct FolderPicker: View {
	let folders: [FolderInfo]
	let choose: (MailAction) -> Void
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			List {
				Section {
					Button { choose(.moveToInbox) } label: { Label("Inbox", systemImage: "tray") }
					Button { choose(.archive) } label: { Label("folder.archive", systemImage: "archivebox") }
				}
				if !folders.isEmpty {
					Section("Folders") {
						ForEach(folders) { folder in
							Button { choose(.moveToFolder(folder.id)) } label: {
								Label { Text(folder.name) } icon: { Image(systemName: "folder").foregroundStyle(Color(hex: folder.color) ?? .accentColor) }
							}
						}
					}
				}
			}
			.foregroundStyle(.primary)
			.navigationTitle("Move to")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
		}
		.presentationDetents([.medium, .large])
	}
}

/// A button for one offer, as used in swipes, menus and toolbars.
struct RowActionButton: View {
	let action: RowAction
	let run: () -> Void

	var body: some View {
		Button(role: action.isDestructive ? .destructive : nil, action: run) {
			Label(action.title, systemImage: action.symbol)
		}
	}
}
