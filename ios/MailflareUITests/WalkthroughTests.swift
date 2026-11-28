import XCTest

/// Walks through the app against a local Mailflare with made-up mail and keeps a screenshot of
/// every step. Start the server first (`node ios/tools/local-server.mjs`) and pass its address:
///
///   TEST_RUNNER_MAILFLARE_UI_SERVER=http://127.0.0.1:8799 xcodebuild test -scheme MailflareUI …
///
/// Without the address the test is skipped, so the ordinary test run does not need a server.
final class WalkthroughTests: XCTestCase {
	private var server = ""
	private let password = "Simulator fixture password!"

	override func setUpWithError() throws {
		continueAfterFailure = false
		guard let address = ProcessInfo.processInfo.environment["MAILFLARE_UI_SERVER"], !address.isEmpty else {
			throw XCTSkip("Set TEST_RUNNER_MAILFLARE_UI_SERVER to the address of a local Mailflare.")
		}
		server = address
	}

	private func launch(reset: Bool = false, offline: Bool = false) -> XCUIApplication {
		let app = XCUIApplication()
		app.launchArguments = ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]
		if reset { app.launchEnvironment["MAILFLARE_UI_RESET"] = "1" }
		if offline { app.launchEnvironment["MAILFLARE_UI_OFFLINE"] = "1" }
		app.launch()
		return app
	}

	private func capture(_ name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}

	private func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 20) {
		XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) did not appear")
	}

	func testSetupReadingAndOffline() throws {
		// Setup: server, access key, sign-in.
		var app = launch(reset: true)
		expect(app.staticTexts["Dein Mailflare"], "The server step")
		capture("01-server")
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
		capture("02-access-key")
		app.buttons["Schlüssel prüfen"].tap()

		expect(app.textFields["E-Mail-Adresse"], "The sign-in step")
		let email = app.textFields["E-Mail-Adresse"]
		email.tap()
		email.typeText("anna@example.test")
		let passwordField = app.secureTextFields["Passwort"]
		passwordField.tap()
		passwordField.typeText(password)
		capture("03-sign-in")
		app.buttons["Anmelden"].firstMatch.tap()

		// The inbox fills from the first sync.
		expect(app.navigationBars["Posteingang"], "The inbox")
		let thread = app.staticTexts["Re: Termin am Donnerstag"].firstMatch
		expect(thread, "The newest message of the conversation", timeout: 40)
		expect(app.staticTexts["Gerade aktualisiert"], "A finished first sync", timeout: 60)
		capture("04-inbox")
		XCTAssertFalse(app.staticTexts["Ihr Konto wurde gesperrt"].exists, "Spam does not belong in the inbox")
		XCTAssertFalse(app.staticTexts["Unterlagen nachreichen"].exists, "Snoozed mail does not belong in the inbox")

		// A category.
		app.buttons["Werbung"].tap()
		expect(app.staticTexts["Neu im Dezember: Lesungen und Öffnungszeiten"], "The newsletter under Werbung")
		capture("05-promotions")
		app.buttons["Allgemein"].tap()

		// The reader: a conversation with an attachment.
		expect(thread, "The conversation again")
		thread.tap()
		expect(app.staticTexts["Unterlagen.pdf"], "The attachment of the opened message")
		expect(app.staticTexts["Weitere Nachrichten dieser Unterhaltung"].firstMatch.exists ? app.staticTexts["Weitere Nachrichten dieser Unterhaltung"].firstMatch : app.staticTexts["anna.krueger@example.org"], "The sender's address")
		capture("06-reader")
		app.navigationBars.buttons.element(boundBy: 0).tap()

		// The root list.
		app.navigationBars.buttons.element(boundBy: 0).tap()
		expect(app.navigationBars["Postfächer"], "The mailbox list")
		capture("07-mailboxes")
		XCTAssertTrue(app.staticTexts["Team"].exists, "The shared mailbox")
		XCTAssertTrue(app.staticTexts["Haus"].exists, "The user's own folder")
		XCTAssertFalse(app.staticTexts["Verwaltung"].exists, "Administration is for administrators")

		// App settings.
		app.staticTexts["Einstellungen"].tap()
		expect(app.staticTexts["Mails offline behalten"], "The app settings")
		capture("08-settings")
		app.navigationBars.buttons.element(boundBy: 0).tap()

		// Give the content of the window time to arrive, then cut the connection.
		app.staticTexts["Posteingang"].firstMatch.tap()
		expect(app.staticTexts["Gerade aktualisiert"], "An up-to-date inbox", timeout: 60)
		sleep(5)
		app.terminate()

		app = launch(offline: true)
		expect(app.navigationBars["Posteingang"], "The inbox without a connection")
		expect(app.staticTexts["Re: Termin am Donnerstag"].firstMatch, "Stored mail without a connection")
		let offline = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Offline'")).firstMatch
		expect(offline, "The offline status", timeout: 30)
		capture("09-offline-inbox")

		// Five messages from different lists open with their content.
		app.staticTexts["Re: Termin am Donnerstag"].firstMatch.tap()
		expect(app.staticTexts["Unterlagen.pdf"], "The attachment row offline")
		XCTAssertFalse(app.staticTexts["Noch nicht auf diesem Gerät"].exists, "The message is on the device")
		capture("10-offline-reader")
		app.navigationBars.buttons.element(boundBy: 0).tap()

		for (chip, subject) in [("Rechnungen", "Ihre Abrechnung für November"), ("Bestellungen", "Ihre Buchung nach Hamburg"), ("Werbung", "Neu im Dezember: Lesungen und Öffnungszeiten")] {
			app.buttons[chip].tap()
			let row = app.staticTexts[subject].firstMatch
			expect(row, "\(subject) offline")
			row.tap()
			expect(app.webViews.firstMatch, "The content of \(subject)")
			XCTAssertFalse(app.staticTexts["Noch nicht auf diesem Gerät"].exists, "\(subject) is on the device")
			capture("11-offline-\(chip)")
			app.navigationBars.buttons.element(boundBy: 0).tap()
		}

		// Dark appearance of the list and the reader.
		XCUIDevice.shared.appearance = .dark
		defer { XCUIDevice.shared.appearance = .light }
		app.buttons["Allgemein"].tap()
		expect(app.staticTexts["Re: Termin am Donnerstag"].firstMatch, "The inbox in dark")
		capture("12-dark-inbox")
		app.staticTexts["Elternabend am 9. Dezember"].firstMatch.tap()
		expect(app.webViews.firstMatch, "A plain-text message in dark")
		capture("13-dark-reader")
	}
}
