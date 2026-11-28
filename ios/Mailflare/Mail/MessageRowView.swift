import SwiftUI
import MailflareKit

struct MessageRowView: View {
	let item: ListItem
	let showsThread: Bool
	private let words = Presentation.current

	private var row: MessageRow { item.message }
	private var isUnread: Bool { showsThread ? item.threadUnread > 0 || !row.read : !row.read }

	var body: some View {
		HStack(alignment: .top, spacing: 8) {
			Circle()
				.fill(isUnread ? Color.accentColor : .clear)
				.frame(width: 9, height: 9)
				.padding(.top, 6)
			VStack(alignment: .leading, spacing: 2) {
				HStack(alignment: .firstTextBaseline) {
					Text(words.correspondent(of: row))
						.font(.headline.weight(isUnread ? .semibold : .regular))
						.lineLimit(1)
					if showsThread && item.threadCount > 1 {
						Text(item.threadCount, format: .number)
							.font(.caption.monospacedDigit())
							.foregroundStyle(.secondary)
					}
					Spacer(minLength: 8)
					if row.starred { Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow) }
					if row.attachmentCount > 0 { Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary) }
					Text(words.rowDate(row.createdAt))
						.font(.subheadline)
						.foregroundStyle(.secondary)
				}
				Text(words.subject(of: row))
					.font(.subheadline.weight(isUnread ? .medium : .regular))
					.lineLimit(1)
				if let snippet = row.snippet, !snippet.isEmpty {
					Text(snippet)
						.font(.subheadline)
						.foregroundStyle(.secondary)
						.lineLimit(2)
				}
				if !row.labels.isEmpty {
					HStack(spacing: 4) {
						ForEach(row.labels.prefix(3), id: \.id) { label in
							Text(label.name)
								.font(.caption2)
								.padding(.horizontal, 6).padding(.vertical, 2)
								.background((Color(hex: label.color) ?? .gray).opacity(0.18), in: Capsule())
						}
					}
				}
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityText)
	}

	private var accessibilityText: Text {
		var parts: [String] = []
		if isUnread { parts.append(words.text("Unread")) }
		parts.append(words.correspondent(of: row))
		parts.append(words.subject(of: row))
		if let snippet = row.snippet, !snippet.isEmpty { parts.append(snippet) }
		parts.append(words.rowDate(row.createdAt))
		if row.starred { parts.append(words.text("Starred")) }
		if row.attachmentCount > 0 { parts.append(words.text("Has attachments")) }
		if showsThread && item.threadCount > 1 { parts.append(words.text("%lld messages", item.threadCount)) }
		return Text(parts.joined(separator: ", "))
	}
}
