import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@Suite struct FormattingTests {
	private let german = Presentation(language: "de", timeZone: TimeZone(identifier: "Europe/Berlin")!)
	private let english = Presentation(language: "en", timeZone: TimeZone(identifier: "Europe/Berlin")!)
	/// Saturday, 28 November 2026, 09:20 in Berlin.
	private let now = Date(timeIntervalSince1970: 1_795_854_000)

	@Test func `the sync status is said in the user's language`() {
		let earlier = now.addingTimeInterval(-6 * 60)
		#expect(german.syncStatus(.idle(last: now.addingTimeInterval(-20)), now: now) == "Gerade aktualisiert")
		#expect(german.syncStatus(.idle(last: earlier), now: now) == "Aktualisiert vor 6 Min.")
		#expect(german.syncStatus(.idle(last: now.addingTimeInterval(-3 * 3600)), now: now) == "Aktualisiert vor 3 Std.")
		#expect(german.syncStatus(.idle(last: nil), now: now) == "Noch nicht abgeglichen")
		#expect(german.syncStatus(.syncing(firstRun: true), now: now) == "Erster Abgleich läuft …")
		#expect(german.syncStatus(.syncing(firstRun: false), now: now) == "Wird aktualisiert …")
		#expect(german.syncStatus(.offline(last: earlier), now: now) == "Offline · Stand 09:14")
		#expect(german.syncStatus(.offline(last: nil), now: now) == "Offline")
		#expect(german.syncStatus(.accessDenied, now: now) == "Zugangsschlüssel abgelehnt")
		#expect(german.syncStatus(.failed(message: nil), now: now) == "Abgleich fehlgeschlagen")
		#expect(english.syncStatus(.idle(last: now.addingTimeInterval(-20)), now: now) == "Updated just now")
		#expect(english.syncStatus(.offline(last: earlier), now: now).hasPrefix("Offline · as of 9:14"))
		#expect(english.syncStatus(.accessDenied, now: now) == "Access key rejected")
	}

	@Test func `an offline status from another day names the day`() {
		let yesterdayEvening = now.addingTimeInterval(-14 * 3600)
		#expect(german.syncStatus(.offline(last: yesterdayEvening), now: now) == "Offline · Stand gestern, 19:20")
	}

	@Test func `a row shows the time today, then yesterday, the weekday and at last the date`() {
		#expect(german.rowDate(now.addingTimeInterval(-8 * 60), now: now) == "09:12")
		#expect(german.rowDate(now.addingTimeInterval(-20 * 3600), now: now) == "Gestern")
		#expect(german.rowDate(now.addingTimeInterval(-3 * 86_400), now: now) == "Mi")
		#expect(german.rowDate(now.addingTimeInterval(-20 * 86_400), now: now) == "08.11.26")
		#expect(english.rowDate(now.addingTimeInterval(-20 * 3600), now: now) == "Yesterday")
		#expect(english.rowDate(now.addingTimeInterval(-3 * 86_400), now: now) == "Wed")
		#expect(english.rowDate(now.addingTimeInterval(-8 * 60), now: now).contains("9:12"))
	}

	@Test func `folders have a name in both languages`() {
		#expect(german.name(of: .inbox) == "Posteingang")
		#expect(german.name(of: .promotions) == "Werbung")
		#expect(german.name(of: .trash) == "Papierkorb")
		#expect(english.name(of: .inbox) == "Inbox")
		for folder in SystemFolder.allCases {
			#expect(!german.name(of: folder).isEmpty)
			#expect(german.name(of: folder) != folder.rawValue)
		}
		#expect(german.categoryChip(.inbox) == "Allgemein")
	}

	@Test func `a row names who the mail is from, or for sent mail who it went to`() {
		let inbound = MessageRow(id: "a", userId: "u", mailboxId: "b", fromAddr: "\"Krüger, Anna\" <anna@example.org>", toAddr: "me@example.test", createdAt: now)
		#expect(german.correspondent(of: inbound) == "Krüger, Anna")
		var known = inbound
		known.fromContactName = "Anna K."
		#expect(german.correspondent(of: known) == "Anna K.")
		let bare = MessageRow(id: "a", userId: "u", mailboxId: "b", fromAddr: "service@stadtwerke.example", toAddr: "me@example.test", createdAt: now)
		#expect(german.correspondent(of: bare) == "service@stadtwerke.example")
		let sent = MessageRow(id: "a", userId: "u", mailboxId: "b", direction: "outbound", fromAddr: "me@example.test", toAddr: "Ben <ben@example.org>, Cleo <cleo@example.org>", status: "sent", createdAt: now)
		#expect(german.correspondent(of: sent) == "An: Ben, Cleo")
		let draft = MessageRow(id: "a", userId: "u", mailboxId: "b", direction: "outbound", fromAddr: "me@example.test", toAddr: "", status: "draft", createdAt: now)
		#expect(german.correspondent(of: draft) == "Kein Empfänger")
		#expect(german.subject(of: draft) == "(Kein Betreff)")
	}
}
