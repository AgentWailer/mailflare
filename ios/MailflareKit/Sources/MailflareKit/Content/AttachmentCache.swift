import Foundation

/// Attachments kept on the device so they open without a connection. One folder per attachment.
public struct AttachmentCache: Sendable {
	public let directory: URL

	public init(directory: URL) {
		self.directory = directory
	}

	/// A folder name that cannot leave the cache whatever the id contains.
	private func folder(_ id: String) -> URL {
		directory.appending(path: id.utf8.map { String(format: "%02x", $0) }.joined(), directoryHint: .isDirectory)
	}

	private func name(_ attachment: AttachmentInfo) -> String {
		APIClient.safeFilename(attachment.filename)
	}

	public func file(for attachment: AttachmentInfo) -> URL? {
		let url = folder(attachment.id).appending(path: name(attachment), directoryHint: .notDirectory)
		return FileManager.default.fileExists(atPath: url.path) ? url : nil
	}

	/// Moves a downloaded file into the cache and returns where it now lives.
	@discardableResult
	public func store(_ downloaded: URL, for attachment: AttachmentInfo) throws -> URL {
		let folder = folder(attachment.id)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let target = folder.appending(path: name(attachment), directoryHint: .notDirectory)
		if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
		try FileManager.default.moveItem(at: downloaded, to: target)
		return target
	}

	/// Removes every cached attachment whose id is not in `ids`.
	public func prune(keeping ids: Set<String>) throws {
		guard FileManager.default.fileExists(atPath: directory.path) else { return }
		let kept = Set(ids.map { folder($0).lastPathComponent })
		for entry in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where !kept.contains(entry.lastPathComponent) {
			try FileManager.default.removeItem(at: entry)
		}
	}
}
