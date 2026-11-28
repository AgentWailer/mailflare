import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@Suite struct MailActionsTests {
	private func row(status: String = "received", direction: String = "inbound", read: Bool = false, starred: Bool = false, snoozed: Bool = false) -> MessageRow {
		MessageRow(id: "m", userId: "u", mailboxId: "box", direction: direction, fromAddr: "a@example.test", toAddr: "b@example.test", status: status,
		           read: read, starred: starred, snoozedUntil: snoozed ? Date().addingTimeInterval(3600) : nil, createdAt: Date())
	}

	@Test func `the inbox archives with one swipe and offers delete, snooze and move on the other side`() {
		let set = MailActions.offered(for: row(), canManage: true)
		#expect(set.leading == [.archive, .markRead])
		#expect(set.trailing == [.trash, .snooze, .move])
		#expect(set.menu == [.markRead, .star, .archive, .move, .snooze, .spam, .trash])
	}

	@Test func `the wording follows the state of the message`() {
		let set = MailActions.offered(for: row(read: true, starred: true, snoozed: true), canManage: true)
		#expect(set.leading == [.archive, .markUnread])
		#expect(set.trailing == [.trash, .unsnooze, .move])
		#expect(set.menu.contains(.unstar) && !set.menu.contains(.star))
	}

	@Test func `archived mail goes back to the inbox, thrown-away mail can be restored or deleted for good`() {
		#expect(MailActions.offered(for: row(status: "archived"), canManage: true).leading.first == .moveToInbox)
		for status in ["trash", "spam"] {
			let set = MailActions.offered(for: row(status: status), canManage: true)
			#expect(set.leading == [.moveToInbox])
			#expect(set.trailing == [.deletePermanently])
			#expect(!set.menu.contains(.trash) && !set.menu.contains(.archive) && !set.menu.contains(.snooze))
		}
	}

	@Test func `mail the user wrote is not archived or snoozed by a swipe`() {
		let sent = MailActions.offered(for: row(status: "sent", direction: "outbound", read: true), canManage: true)
		#expect(sent.leading == [.star])
		#expect(sent.trailing == [.trash])
		let draft = MailActions.offered(for: row(status: "draft", direction: "outbound", read: true), canManage: true)
		#expect(draft.trailing == [.trash])
		#expect(draft.leading.isEmpty)
	}

	@Test func `a mailbox that may only be read offers reading and starring, nothing that moves mail`() {
		let set = MailActions.offered(for: row(), canManage: false)
		#expect(set.leading == [.markRead])
		#expect(set.trailing == [.star])
		#expect(set.menu == [.markRead, .star])
	}

	@Test func `each offer maps to the action the server knows`() {
		let until = Date(timeIntervalSince1970: 1_800_000_000)
		#expect(RowAction.archive.mailAction() == .archive)
		#expect(RowAction.markRead.mailAction() == .markRead(true))
		#expect(RowAction.markUnread.mailAction() == .markRead(false))
		#expect(RowAction.star.mailAction() == .star(true))
		#expect(RowAction.unstar.mailAction() == .star(false))
		#expect(RowAction.moveToInbox.mailAction() == .moveToInbox)
		#expect(RowAction.deletePermanently.mailAction() == .deletePermanently)
		#expect(RowAction.unsnooze.mailAction() == .unsnooze)
		#expect(RowAction.snooze.mailAction(until: until) == .snooze(until: until))
		#expect(RowAction.move.mailAction(folderId: "f1") == .moveToFolder("f1"))
		#expect(RowAction.snooze.mailAction() == nil, "snoozing needs a time")
		#expect(RowAction.move.mailAction() == nil, "moving needs a folder")
	}

	@Test func `snooze offers later today only while there is a later, then tomorrow and next week`() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
		// Saturday, 28 November 2026.
		let morning = calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 9, minute: 20))!
		let evening = calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 19, minute: 5))!
		let options = SnoozePreset.options(now: morning, calendar: calendar)
		#expect(options.map(\.kind) == [.laterToday, .tomorrow, .nextWeek])
		#expect(options[0].date == calendar.date(from: DateComponents(year: 2026, month: 11, day: 28, hour: 18))!)
		#expect(options[1].date == calendar.date(from: DateComponents(year: 2026, month: 11, day: 29, hour: 8))!)
		#expect(options[2].date == calendar.date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 8))!, "the coming Monday")
		#expect(SnoozePreset.options(now: evening, calendar: calendar).map(\.kind) == [.tomorrow, .nextWeek])
		let monday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 10))!
		#expect(SnoozePreset.options(now: monday, calendar: calendar).last?.date == calendar.date(from: DateComponents(year: 2026, month: 12, day: 7, hour: 8))!, "on a Monday, the Monday after")
		#expect(options.allSatisfy { $0.date > morning })
	}

	@Test func `a mailbox is manageable unless it was shared for reading only`() {
		func box(_ permission: String?) -> MailboxInfo { MailboxInfo(id: "box", userId: "u", localPart: "a", hostname: "example.test", permission: permission) }
		#expect(MailActions.canManage(mailboxId: "box", in: MailboxTree(mailboxes: [box("full_access")])))
		#expect(MailActions.canManage(mailboxId: "box", in: MailboxTree(mailboxes: [box(nil)])))
		#expect(!MailActions.canManage(mailboxId: "box", in: MailboxTree(mailboxes: [box("read_only")])))
		#expect(!MailActions.canManage(mailboxId: "other", in: MailboxTree(mailboxes: [box("full_access")])), "an unknown mailbox is not managed")
		#expect(!MailActions.canManage(mailboxId: nil, in: MailboxTree(mailboxes: [box("full_access")])))
	}
}
