import Foundation
import Testing
@testable import MailflareKit

@Suite struct AttachmentCacheTests {
	private func cache() -> (AttachmentCache, URL) {
		let directory = FileManager.default.temporaryDirectory.appending(path: "mailflare-cache-\(UUID().uuidString)")
		return (AttachmentCache(directory: directory), directory)
	}

	private func temporaryFile(_ text: String) throws -> URL {
		let url = FileManager.default.temporaryDirectory.appending(path: "download-\(UUID().uuidString)")
		try Data(text.utf8).write(to: url)
		return url
	}

	@Test func `a stored attachment is found again under its own name`() throws {
		let (cache, directory) = cache()
		defer { try? FileManager.default.removeItem(at: directory) }
		let attachment = AttachmentInfo(id: "a/1", messageId: "m1", filename: "../Unter lagen.pdf", type: "application/pdf", size: 3)
		#expect(cache.file(for: attachment) == nil)
		let stored = try cache.store(try temporaryFile("PDF"), for: attachment)
		#expect(stored.lastPathComponent == ".._Unter lagen.pdf")
		#expect(stored.path.hasPrefix(directory.path), "the file stays inside the cache")
		#expect(cache.file(for: attachment) == stored)
		#expect(try String(contentsOf: stored, encoding: .utf8) == "PDF")
	}

	@Test func `pruning keeps the given attachments and removes the rest`() throws {
		let (cache, directory) = cache()
		defer { try? FileManager.default.removeItem(at: directory) }
		let keep = AttachmentInfo(id: "keep", messageId: "m1", filename: "a.txt", type: "text/plain", size: 1)
		let drop = AttachmentInfo(id: "drop", messageId: "m2", filename: "b.txt", type: "text/plain", size: 1)
		_ = try cache.store(try temporaryFile("a"), for: keep)
		_ = try cache.store(try temporaryFile("b"), for: drop)
		try cache.prune(keeping: ["keep"])
		#expect(cache.file(for: keep) != nil)
		#expect(cache.file(for: drop) == nil)
		try cache.prune(keeping: [])
		#expect(cache.file(for: keep) == nil)
	}
}
