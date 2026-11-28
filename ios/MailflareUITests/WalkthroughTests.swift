import XCTest

/// Walks through the app against a local Mailflare with made-up mail and keeps a screenshot of
/// every step. Start the server first (`node ios/tools/local-server.mjs`) and pass its address:
///
///   TEST_RUNNER_MAILFLARE_UI_SERVER=http://127.0.0.1:8799 xcodebuild test -scheme MailflareUI …
///
/// Without the address the test is skipped, so the ordinary test run does not need a server.
final class WalkthroughTests: XCTestCase {
	nonisolated(unsafe) private var server = ""
	private let password = "Simulator fixture password!"

	override func setUpWithError() throws {
		continueAfterFailure = false
		guard let address = ProcessInfo.processInfo.environment["MAILFLARE_UI_SERVER"], !address.isEmpty else {
			throw XCTSkip("Set TEST_RUNNER_MAILFLARE_UI_SERVER to the address of a local Mailflare.")
		}
		server = address
		// iOS offers to save a password that was typed, some time after the sign-in and from a
		// process of its own. Until it is answered it swallows every tap.
		addUIInterruptionMonitor(withDescription: "Save password") { alert in
			for title in ["Später", "Not Now", "Jetzt nicht"] where alert.buttons[title].exists {
				alert.buttons[title].tap()
				return true
			}
			return false
		}
	}

	@MainActor private func launch(reset: Bool = false, offline: Bool = false, dark: Bool = false) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]
		// iOS would offer to save the made-up password and cover the app until answered.
		app.launchEnvironment["MAILFLARE_UI_NO_PASSWORD_SAVING"] = "1"
		if reset { app.launchEnvironment["MAILFLARE_UI_RESET"] = "1" }
		if offline { app.launchEnvironment["MAILFLARE_UI_OFFLINE"] = "1" }
		if dark { app.launchEnvironment["MAILFLARE_UI_DARK"] = "1" }
		app.launch()
		return app
	}

	@MainActor private func capture(_ name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}

	/// Taps a category by its place on screen. After the row of categories has been scrolled,
	/// XCUITest no longer works out a hit point for its buttons, though a finger hits them.
	@MainActor private func tapCategory(_ name: String, in app: XCUIApplication) {
		let chip = app.buttons[name]
		XCTAssertTrue(chip.waitForExistence(timeout: 10), "The category \(name)")
		sleep(1)
		chip.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)).tap() // near its left end: the right end may be cut off by the screen
	}

	/// Swipes a row open from its leading edge. XCUITest's swipe does not always catch the row
	/// on the first try, so it is repeated once.
	@MainActor private func revealLeadingActions(of row: XCUIElement, in app: XCUIApplication) {
		for _ in 0..<2 where !app.buttons["Archivieren"].exists {
			row.swipeRight(velocity: .slow)
			_ = app.buttons["Archivieren"].waitForExistence(timeout: 3)
		}
	}

	@MainActor private func back(_ app: XCUIApplication) {
		app.navigationBars.buttons.element(boundBy: 0).tap()
	}

	@MainActor private func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 20) {
		XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) did not appear")
	}

	/// Starts as a fresh install and goes through server, access key and sign-in.
	@MainActor private func signInFresh(capturing: Bool = true) -> XCUIApplication {
		// Setup: server, access key, sign-in.
		let app = launch(reset: true)
		expect(app.staticTexts["Dein Mailflare"], "The server step")
		if capturing { capture("01-server") }
		let address = app.textFields["Serveradresse"]
		address.tap()
		address.typeText(server)
		app.buttons["Weiter"].tap()

		expect(app.staticTexts["Zugangsschlüssel"], "The access key step")
		let clientId = app.textFields["Client-ID"]
		clientId.tap()
		clientId.typeText("simulator.access")
		let secret = app.secureTextFields["Client-Secret"]
		secret.tap()
		secret.typeText("simulator-secret")
		if capturing { capture("02-access-key") }
		app.buttons["Schlüssel prüfen"].tap()

		expect(app.textFields["E-Mail-Adresse"], "The sign-in step")
		let email = app.textFields["E-Mail-Adresse"]
		email.tap()
		email.typeText("anna@example.test")
		let passwordField = app.secureTextFields["Passwort"]
		passwordField.tap()
		passwordField.typeText(password)
		if capturing { capture("03-sign-in") }
		app.buttons["Anmelden"].firstMatch.tap()

		return app
	}

	@MainActor func testSetupReadingAndOffline() throws {
		var app = signInFresh()

		// The inbox fills from the first sync.
		expect(app.navigationBars["Posteingang"], "The inbox")
		let thread = app.staticTexts["Re: Termin am Donnerstag"].firstMatch
		expect(thread, "The newest message of the conversation", timeout: 40)
		expect(app.staticTexts["Gerade aktualisiert"], "A finished first sync", timeout: 60)
		capture("04-inbox")
		XCTAssertFalse(app.staticTexts["Ihr Konto wurde gesperrt"].exists, "Spam does not belong in the inbox")
		XCTAssertFalse(app.staticTexts["Unterlagen nachreichen"].exists, "Snoozed mail does not belong in the inbox")

		// The reader: a conversation with an attachment.
		thread.tap()
		expect(app.staticTexts["Unterlagen.pdf"], "The attachment of the opened message")
		expect(app.staticTexts["anna.krueger@example.org"], "The sender's address under the name")
		expect(app.webViews.staticTexts["Prima, dann bis Donnerstag. Die Unterlagen hängen an."], "The text of the message")
		sleep(1)
		capture("05-reader")
		back(app)

		// Categories: the list is swapped, the row of categories stays.
		tapCategory("Rechnungen", in: app)
		expect(app.staticTexts["Ihre Abrechnung für November"], "The invoice under Rechnungen")
		// The invoice is also part of the general inbox; the swap shows in what is gone.
		XCTAssertTrue(app.staticTexts["Elternabend am 9. Dezember"].waitForNonExistence(timeout: 10), "Only invoices are listed")
		capture("06-invoices")

		// An HTML newsletter, reached through the list of all mail.
		back(app)
		expect(app.navigationBars["Postfächer"], "The mailbox list")
		app.swipeUp()
		app.staticTexts["Alle Mails"].firstMatch.tap()
		let newsletter = app.staticTexts["Neu im Dezember: Lesungen und Öffnungszeiten"].firstMatch
		expect(newsletter, "The newsletter among all mail")
		newsletter.tap()
		expect(app.webViews.staticTexts["Dezember in der Bibliothek"], "The newsletter's content")
		expect(app.buttons["Bilder aus dem Internet laden"], "The offer to load remote pictures")
		sleep(1)
		capture("07-newsletter")
		back(app)

		// The root list.
		back(app)
		expect(app.navigationBars["Postfächer"], "The mailbox list")
		XCTAssertTrue(app.staticTexts["Haus"].waitForExistence(timeout: 5), "The user's own folder")
		XCTAssertFalse(app.staticTexts["Verwaltung"].exists, "Administration is for administrators")
		capture("09-mailboxes-lower")
		app.swipeDown()
		XCTAssertTrue(app.staticTexts["Team"].waitForExistence(timeout: 5), "The shared mailbox")
		capture("08-mailboxes")
		app.swipeUp()

		// An area without a native screen opens as its web page, signed in as the same account.
		// Over the test server's plain http the page arrives without its styles and scripts:
		// Mailflare's pages tell the browser to load every part over https. What can be seen
		// here is that the page is served to a signed-in user and does not ask to sign in.
		app.staticTexts["Kalender"].firstMatch.tap()
		expect(app.webViews.firstMatch, "The calendar's web page")
		sleep(4)
		capture("09b-web-calendar")
		expect(app.webViews.links.firstMatch, "Content of the page")
		XCTAssertFalse(app.webViews.secureTextFields.firstMatch.waitForExistence(timeout: 5), "The web page asks to sign in again")
		XCTAssertFalse(app.staticTexts["Diese Seite kann nicht geöffnet werden"].exists, "The page failed to load")
		back(app)

		// App settings.
		app.staticTexts["Einstellungen"].firstMatch.tap()
		expect(app.staticTexts["Mails offline behalten"], "The app settings")
		capture("10-settings")
		app.swipeUp()
		expect(app.staticTexts["Angemeldete Geräte"], "The signed-in devices")
		capture("11-settings-devices")
		back(app)

		// Give the content of the window time to arrive, then cut the connection.
		app.swipeDown()
		app.staticTexts["Posteingang"].firstMatch.tap()
		// "Gerade aktualisiert", or "Aktualisiert vor 1 Min." when the walk-through took a while.
		expect(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'aktualisiert'")).firstMatch, "An up-to-date inbox", timeout: 60)
		sleep(5)
		app.terminate()

		app = launch(offline: true)
		expect(app.staticTexts["Re: Termin am Donnerstag"].firstMatch, "Stored mail without a connection")
		let offline = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Offline'")).firstMatch
		expect(offline, "The offline status", timeout: 30)
		capture("12-offline-inbox")

		// Messages from five different lists open with their content, without a connection.
		app.staticTexts["Re: Termin am Donnerstag"].firstMatch.tap()
		expect(app.webViews.staticTexts["Prima, dann bis Donnerstag. Die Unterlagen hängen an."], "The conversation's text offline")
		XCTAssertFalse(app.staticTexts["Noch nicht auf diesem Gerät"].exists, "The message is on the device")
		capture("13-offline-reader")
		back(app)
		back(app)
		expect(app.navigationBars["Postfächer"], "The mailbox list offline")
		for (folder, subject, text) in [
			("Team", "Frage zur Bestellung", "Guten Tag, wann wird meine Bestellung geliefert?"),
			("Zurückgestellt", "Unterlagen nachreichen", "Bitte reichen Sie die Unterlagen bis Monatsende nach."),
			("Spam", "Ihr Konto wurde gesperrt", "Bitte bestätigen Sie Ihre Daten."),
			("Gesendet", "Re: Termin am Donnerstag", "ja, 14 Uhr passt gut."),
		] {
			app.staticTexts[folder].firstMatch.tap()
			let row = app.staticTexts[subject].firstMatch
			expect(row, "\(subject) in \(folder), offline")
			row.tap()
			expect(app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch, "The content of \(subject), offline")
			XCTAssertFalse(app.staticTexts["Noch nicht auf diesem Gerät"].exists, "\(subject) is on the device")
			sleep(1)
			capture("14-offline-\(folder)")
			back(app)
			back(app)
			expect(app.navigationBars["Postfächer"], "The mailbox list again")
		}

		// Dark appearance of the list and of both kinds of message, still without a connection.
		app.terminate()
		app = launch(offline: true, dark: true)
		// The app reopens on the list that was open last; the mailbox list is one step back.
		if !app.navigationBars["Postfächer"].waitForExistence(timeout: 8) { back(app) }
		expect(app.navigationBars["Postfächer"], "The mailbox list in dark")
		sleep(1)
		capture("15-dark-mailboxes")
		app.staticTexts["Posteingang"].firstMatch.tap()
		expect(app.staticTexts["Re: Termin am Donnerstag"].firstMatch, "The inbox in dark")
		sleep(1)
		capture("16-dark-inbox")
		app.staticTexts["Elternabend am 9. Dezember"].firstMatch.tap()
		expect(app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Elternabend'")).firstMatch, "A plain-text message in dark")
		sleep(1)
		capture("17-dark-plain")
		back(app)
		back(app)
		app.swipeUp()
		app.staticTexts["Alle Mails"].firstMatch.tap()
		app.staticTexts["Neu im Dezember: Lesungen und Öffnungszeiten"].firstMatch.tap()
		expect(app.webViews.staticTexts["Dezember in der Bibliothek"], "The newsletter in dark")
		sleep(1)
		capture("18-dark-newsletter")
	}

	/// Reading, swiping and selecting change mail at once, reach the server, and survive a start without a connection.
	@MainActor func testActions() throws {
		var app = signInFresh(capturing: false)
		expect(app.navigationBars["Posteingang"], "The inbox")
		let invoice = app.staticTexts["Ihre Abrechnung für November"].firstMatch
		expect(invoice, "An unread message", timeout: 40)
		expect(app.staticTexts["Gerade aktualisiert"], "A finished first sync", timeout: 60)
		// The row reads itself out as one sentence that starts with its unread state.
		let unreadRow = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Ungelesen, Stadtwerke'")).firstMatch
		expect(unreadRow, "The invoice shown as unread")

		// Opening a message marks it read.
		invoice.tap()
		expect(app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Abrechnung'")).firstMatch, "The invoice's text")
		capture("20-reader-with-actions")
		back(app)
		XCTAssertTrue(unreadRow.waitForNonExistence(timeout: 10), "The opened message is no longer shown as unread")
		capture("21-inbox-after-reading")

		// A full swipe archives.
		let kita = app.staticTexts["Elternabend am 9. Dezember"].firstMatch
		expect(kita, "The message to archive")
		revealLeadingActions(of: kita, in: app)
		expect(app.buttons["Archivieren"], "Archive in the swipe from the leading edge")
		capture("21b-swipe-leading")
		app.buttons["Archivieren"].tap()
		XCTAssertTrue(kita.waitForNonExistence(timeout: 10), "The archived message leaves the inbox")

		// The other side offers delete, snooze and move.
		let offer = app.staticTexts["Angebot Dach"].firstMatch
		offer.swipeLeft(velocity: .slow)
		expect(app.buttons["Löschen"], "Delete in the swipe")
		expect(app.buttons["Zurückstellen"], "Snooze in the swipe")
		capture("22-swipe-actions")
		app.buttons["Zurückstellen"].tap()
		expect(app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Morgen früh'")).firstMatch, "The snooze times")
		capture("23-snooze-times")
		app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Morgen früh'")).firstMatch.tap()
		XCTAssertTrue(offer.waitForNonExistence(timeout: 10), "The snoozed message leaves the inbox")

		// Several at once.
		app.buttons["Auswählen"].tap()
		app.staticTexts["Rundschreiben Nr. 1"].firstMatch.tap()
		app.staticTexts["Rundschreiben Nr. 2"].firstMatch.tap()
		capture("24-selection")
		app.buttons["Löschen"].firstMatch.tap()
		XCTAssertTrue(app.staticTexts["Rundschreiben Nr. 1"].firstMatch.waitForNonExistence(timeout: 10), "The deleted messages leave the inbox")
		XCTAssertTrue(app.staticTexts["Rundschreiben Nr. 3"].firstMatch.exists, "The others stay")

		// Everything went where it should.
		back(app)
		expect(app.navigationBars["Postfächer"], "The mailbox list")
		for (folder, subject) in [("Archiv", "Elternabend am 9. Dezember"), ("Zurückgestellt", "Angebot Dach"), ("Papierkorb", "Rundschreiben Nr. 2")] {
			app.staticTexts[folder].firstMatch.tap()
			expect(app.staticTexts[subject].firstMatch, "\(subject) under \(folder)")
			back(app)
		}

		// Give the server time to take the changes, then act without a connection.
		app.staticTexts["Posteingang"].firstMatch.tap()
		sleep(6)
		app.terminate()
		app = launch(offline: true)
		expect(app.staticTexts["Ihre Buchung nach Hamburg"].firstMatch, "The inbox without a connection")
		XCTAssertFalse(app.staticTexts["Elternabend am 9. Dezember"].exists, "What was archived stays archived")
		revealLeadingActions(of: app.staticTexts["Ihre Buchung nach Hamburg"].firstMatch, in: app)
		expect(app.buttons["Archivieren"], "Archive in the swipe, offline")
		app.buttons["Archivieren"].tap()
		XCTAssertTrue(app.staticTexts["Ihre Buchung nach Hamburg"].firstMatch.waitForNonExistence(timeout: 10), "Archiving works offline")
		capture("25-offline-after-archiving")
		app.terminate()

		// Back online, the waiting action goes out and stays done.
		app = launch()
		expect(app.staticTexts["Ihre Abrechnung für November"].firstMatch, "The inbox online again")
		expect(app.staticTexts["Gerade aktualisiert"], "A sync after coming back", timeout: 60)
		XCTAssertFalse(app.staticTexts["Ihre Buchung nach Hamburg"].exists, "The message archived offline is still archived after the sync")
	}
}
