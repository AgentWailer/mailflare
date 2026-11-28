import Foundation
import MailflareKit

/// Words and dates as the user reads them. The app uses the system's language; a test names one.
struct Presentation {
	let bundle: Bundle
	let locale: Locale
	let calendar: Calendar

	static var current: Presentation { Presentation(language: nil) }

	init(language: String?, timeZone: TimeZone = .current) {
		if let language, let path = Bundle.main.path(forResource: language, ofType: "lproj"), let bundle = Bundle(path: path) {
			self.bundle = bundle
			locale = Locale(identifier: language == "de" ? "de_DE" : "en_US")
		} else {
			bundle = .main
			locale = .current
		}
		var calendar = Calendar(identifier: .gregorian)
		calendar.locale = locale
		calendar.timeZone = timeZone
		self.calendar = calendar
	}

	func text(_ key: String, _ arguments: any CVarArg...) -> String {
		let format = bundle.localizedString(forKey: key, value: key, table: nil)
		return arguments.isEmpty ? format : String(format: format, locale: locale, arguments: arguments)
	}

	private func time(_ date: Date) -> String {
		date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).hour().minute())
	}

	private func shortDate(_ date: Date) -> String {
		date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).day(.twoDigits).month(.twoDigits).year(.twoDigits))
	}

	private func daysAgo(_ date: Date, now: Date) -> Int {
		calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
	}

	// MARK: Lists

	/// The time today, "Yesterday", the weekday within a week, otherwise the date.
	func rowDate(_ date: Date, now: Date = Date()) -> String {
		switch daysAgo(date, now: now) {
		case ...0: time(date)
		case 1: text("Yesterday")
		case 2...6: date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated))
		default: shortDate(date)
		}
	}

	/// A full date and time, for the head of an opened message.
	func fullDate(_ date: Date) -> String {
		date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).day().month(.abbreviated).year().hour().minute())
	}

	func syncStatus(_ status: SyncStatus, now: Date = Date()) -> String {
		switch status {
		case .idle(let last?):
			let minutes = Int(now.timeIntervalSince(last) / 60)
			if minutes < 1 { return text("Updated just now") }
			if minutes < 60 { return text("Updated %lld min ago", minutes) }
			if minutes < 24 * 60 { return text("Updated %lld h ago", minutes / 60) }
			return text("Updated %@", shortDate(last))
		case .idle(nil): return text("Not synced yet")
		case .syncing(firstRun: true): return text("First sync in progress …")
		case .syncing(firstRun: false): return text("Updating …")
		case .offline(let last?):
			let when = switch daysAgo(last, now: now) {
			case ...0: time(last)
			case 1: text("yesterday, %@", time(last))
			default: "\(shortDate(last)), \(time(last))"
			}
			return text("Offline · as of %@", when)
		case .offline(nil): return text("Offline")
		case .accessDenied: return text("Access key rejected")
		case .signedOut: return text("Signed out")
		case .failed(let reason?): return "\(text("Sync failed")) (\(reason))"
		case .failed(nil): return text("Sync failed")
		}
	}

	// MARK: Folders

	func name(of folder: SystemFolder) -> String {
		switch folder {
		case .inbox: text("Inbox")
		case .promotions: text("Promotions")
		case .social: text("Social")
		case .invoices: text("Invoices")
		case .orders: text("Orders")
		case .starred: text("Starred")
		case .snoozed: text("Snoozed")
		case .scheduled: text("Scheduled")
		case .sent: text("Sent")
		case .drafts: text("Drafts")
		case .archived: text("folder.archive")
		case .spam: text("Spam")
		case .trash: text("Trash")
		case .all: text("All mail")
		}
	}

	/// The inbox itself is called "General" among its categories.
	func categoryChip(_ folder: SystemFolder) -> String {
		folder == .inbox ? text("General") : name(of: folder)
	}

	static func symbol(of folder: SystemFolder) -> String {
		switch folder {
		case .inbox: "tray"
		case .promotions: "tag"
		case .social: "person.2"
		case .invoices: "doc.text"
		case .orders: "shippingbox"
		case .starred: "star"
		case .snoozed: "clock"
		case .scheduled: "calendar.badge.clock"
		case .sent: "paperplane"
		case .drafts: "doc"
		case .archived: "archivebox"
		case .spam: "xmark.bin"
		case .trash: "trash"
		case .all: "tray.2"
		}
	}

	// MARK: Messages

	/// Who a row is about: the sender, or for mail the user wrote, the recipients.
	func correspondent(of row: MessageRow) -> String {
		if row.direction == "outbound" {
			let recipients = MailAddress.list(row.toAddr)
			if recipients.isEmpty { return text("No recipient") }
			let names = recipients.count == 1 && row.toContactName != nil ? [row.toContactName!] : recipients.map(\.label)
			return text("To: %@", names.joined(separator: ", "))
		}
		return row.fromContactName ?? MailAddress(row.fromAddr).label
	}

	func subject(of row: MessageRow) -> String {
		let subject = row.subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return subject.isEmpty ? text("(No subject)") : subject
	}
}
