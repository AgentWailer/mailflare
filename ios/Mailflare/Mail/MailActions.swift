import SwiftUI
import MailflareKit

/// What can be done to a message from a row, a menu or the reader.
enum RowAction: Hashable {
	case archive, trash, deletePermanently, moveToInbox, spam
	case markRead, markUnread, star, unstar
	case snooze, unsnooze, move

	/// The action sent to the server. Snoozing needs a time and moving a folder.
	func mailAction(until: Date? = nil, folderId: String? = nil) -> MailAction? {
		switch self {
		case .archive: .archive
		case .trash: .trash
		case .deletePermanently: .deletePermanently
		case .moveToInbox: .moveToInbox
		case .spam: .spam
		case .markRead: .markRead(true)
		case .markUnread: .markRead(false)
		case .star: .star(true)
		case .unstar: .star(false)
		case .unsnooze: .unsnooze
		case .snooze: until.map { .snooze(until: $0) }
		case .move: folderId.map { .moveToFolder($0) }
		}
	}

	var title: LocalizedStringKey {
		switch self {
		case .archive: "Archive"
		case .trash: "Delete"
		case .deletePermanently: "Delete for good"
		case .moveToInbox: "Move to inbox"
		case .spam: "Mark as spam"
		case .markRead: "Mark as read"
		case .markUnread: "Mark as unread"
		case .star: "Star"
		case .unstar: "Remove star"
		case .snooze: "Snooze"
		case .unsnooze: "Wake now"
		case .move: "Move"
		}
	}

	var symbol: String {
		switch self {
		case .archive: "archivebox"
		case .trash: "trash"
		case .deletePermanently: "trash.slash"
		case .moveToInbox: "tray.and.arrow.down"
		case .spam: "xmark.bin"
		case .markRead: "envelope.open"
		case .markUnread: "envelope.badge"
		case .star: "star"
		case .unstar: "star.slash"
		case .snooze: "clock"
		case .unsnooze: "alarm"
		case .move: "folder"
		}
	}

	var tint: Color {
		switch self {
		case .archive, .moveToInbox: .green
		case .trash, .deletePermanently, .spam: .red
		case .markRead, .markUnread: .blue
		case .star, .unstar: .yellow
		case .snooze, .unsnooze: .orange
		case .move: .indigo
		}
	}

	var isDestructive: Bool { self == .trash || self == .deletePermanently || self == .spam }
}

enum MailActions {
	struct Offer: Equatable {
		/// Swipe from the leading edge; the first one happens on a full swipe.
		var leading: [RowAction]
		/// Swipe from the trailing edge.
		var trailing: [RowAction]
		/// The long-press menu and the reader's menu: everything that applies.
		var menu: [RowAction]
	}

	/// What a message offers, by where it is and by what the account may do in its mailbox.
	static func offered(for row: MessageRow, canManage: Bool) -> Offer {
		let read: RowAction = row.read ? .markUnread : .markRead
		let star: RowAction = row.starred ? .unstar : .star
		guard canManage else { return Offer(leading: [read], trailing: [star], menu: [read, star]) }
		let snooze: RowAction = (row.snoozedUntil ?? .distantPast) > Date() ? .unsnooze : .snooze

		switch row.status {
		case "trash", "spam":
			return Offer(leading: [.moveToInbox], trailing: [.deletePermanently], menu: [read, star, .moveToInbox, .deletePermanently])
		case "archived":
			return Offer(leading: [.moveToInbox, read], trailing: [.trash, .move], menu: [read, star, .moveToInbox, .move, .spam, .trash])
		case "draft":
			return Offer(leading: [], trailing: [.trash], menu: [.trash])
		default:
			if row.direction == "outbound" {
				return Offer(leading: [star], trailing: [.trash], menu: [star, .trash])
			}
			return Offer(leading: [.archive, read], trailing: [.trash, snooze, .move], menu: [read, star, .archive, .move, snooze, .spam, .trash])
		}
	}

	/// True unless the mailbox was shared with this account for reading only.
	static func canManage(mailboxId: String?, in tree: MailboxTree) -> Bool {
		guard let mailboxId, let mailbox = tree.mailboxes.first(where: { $0.id == mailboxId }) else { return false }
		return mailbox.permission != "read_only"
	}
}

/// A time to snooze a message until.
struct SnoozePreset: Equatable, Identifiable {
	enum Kind: Equatable { case laterToday, tomorrow, nextWeek }
	let kind: Kind
	let date: Date

	var id: Date { date }

	var title: LocalizedStringKey {
		switch kind {
		case .laterToday: "This evening"
		case .tomorrow: "Tomorrow morning"
		case .nextWeek: "Next week"
		}
	}

	/// This evening at 18:00 while that is at least an hour away, tomorrow at 8:00, and the coming Monday at 8:00.
	static func options(now: Date = Date(), calendar: Calendar = .current) -> [SnoozePreset] {
		var options: [SnoozePreset] = []
		let today = calendar.startOfDay(for: now)
		if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: today), evening.timeIntervalSince(now) >= 3600 {
			options.append(SnoozePreset(kind: .laterToday, date: evening))
		}
		if let tomorrow = calendar.date(byAdding: .day, value: 1, to: today), let morning = calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) {
			options.append(SnoozePreset(kind: .tomorrow, date: morning))
		}
		// Monday is weekday 2 in the Gregorian calendar; today does not count.
		let weekday = calendar.component(.weekday, from: today)
		let daysToMonday = ((2 - weekday + 7) % 7 == 0) ? 7 : (2 - weekday + 7) % 7
		if let monday = calendar.date(byAdding: .day, value: daysToMonday, to: today), let morning = calendar.date(bySettingHour: 8, minute: 0, second: 0, of: monday),
		   !options.contains(where: { $0.date == morning }) {
			options.append(SnoozePreset(kind: .nextWeek, date: morning))
		}
		return options
	}
}

extension AccountSession {
	/// Does something to messages: shown at once, sent to the server by the sync that follows.
	func perform(_ action: MailAction, on messageIds: [String]) async {
		guard !messageIds.isEmpty else { return }
		await engine.perform(action, messageIds: messageIds)
		let engine = engine
		Task { await engine.syncNow() }
	}
}
