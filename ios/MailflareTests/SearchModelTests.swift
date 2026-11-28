import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@MainActor @Suite struct SearchModelTests {
	private func row(_ id: String) -> MessageRow {
		MessageRow(id: id, userId: "u", mailboxId: "box", direction: "inbound", category: "primary", fromAddr: "a@example.test", toAddr: "b@example.test",
		           subject: id, status: "received", read: true, starred: false, createdAt: Date(timeIntervalSince1970: 1_795_000_000), attachmentCount: 0, labels: [])
	}

	private func settled(_ model: SearchModel) async {
		for _ in 0..<200 where model.serverState == .searching { try? await Task.sleep(for: .milliseconds(5)) }
	}

	@Test func `what the device holds shows at once and the server adds only what it does not hold`() async {
		let model = SearchModel(pause: .zero, local: { _ in [ListItem(message: self.row("here"))] }, remote: { _ in [self.row("here"), self.row("old")] })
		model.search(" rechnung ")
		#expect(model.text == "rechnung")
		#expect(model.onDevice.map(\.id) == ["here"])
		#expect(model.serverState == .searching)
		await settled(model)
		#expect(model.onServer.map(\.id) == ["old"])
		#expect(model.serverState == .done)
	}

	@Test func `the answer to an earlier text is not shown under a later one`() async {
		let model = SearchModel(pause: .zero, local: { _ in [] }, remote: { text in
			if text == "a" { try? await Task.sleep(for: .milliseconds(80)) }
			return [self.row("for-" + text)]
		})
		model.search("a")
		try? await Task.sleep(for: .milliseconds(10))
		model.search("ab")
		await settled(model)
		try? await Task.sleep(for: .milliseconds(120))
		#expect(model.onServer.map(\.id) == ["for-ab"])
	}

	@Test func `typing fast asks the server once`() async {
		let asked = Counter()
		let model = SearchModel(pause: .milliseconds(40), local: { _ in [] }, remote: { _ in await asked.add(); return [] })
		for text in ["r", "re", "rec", "rech"] { model.search(text) }
		await settled(model)
		#expect(await asked.value == 1)
	}

	@Test func `without a network the device's results stay and the state says so`() async {
		let model = SearchModel(pause: .zero, local: { _ in [ListItem(message: self.row("here"))] }, remote: { _ in throw APIError.offline })
		model.search("x")
		await settled(model)
		#expect(model.onDevice.map(\.id) == ["here"])
		#expect(model.serverState == .needsNetwork)
	}

	@Test func `clearing the field clears the results`() async {
		let model = SearchModel(pause: .zero, local: { _ in [ListItem(message: self.row("here"))] }, remote: { _ in [self.row("old")] })
		model.search("x")
		await settled(model)
		model.search("")
		#expect(model.isEmpty)
		#expect(model.serverState == .idle)
		#expect(!model.isSearching)
	}
}

private actor Counter {
	var value = 0
	func add() { value += 1 }
}
