import SwiftUI
import MailflareKit

/// One recipient line: the chosen people as chips, a field to type the next one, and
/// suggestions from the address book while typing.
struct RecipientField: View {
	let title: LocalizedStringKey
	let identifier: String
	@Binding var entries: [String]
	let suggest: (String) -> [RecipientCandidate]
	let entry: (RecipientCandidate) -> String
	@State private var typed = ""
	@FocusState private var isFocused: Bool

	/// Takes what was typed as a recipient. Several addresses may be pasted at once.
	private func commit() {
		let parts = MailAddress.list(typed.replacingOccurrences(of: ";", with: ","))
		guard !parts.isEmpty else { return }
		for part in parts {
			let text = part.name.map { "\($0) <\(part.address)>" } ?? part.address
			if !entries.contains(where: { MailAddress($0).address.caseInsensitiveCompare(part.address) == .orderedSame }) { entries.append(text) }
		}
		typed = ""
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(title).foregroundStyle(.secondary).frame(minWidth: 34, alignment: .leading)
				FlowLayout(spacing: 6) {
					ForEach(entries, id: \.self) { item in
						let valid = ComposeModel.isValid(item)
						Button {
							Haptics.play(.selection)
							entries.removeAll { $0 == item }
						} label: {
							HStack(spacing: 4) {
								Text(MailAddress(item).label).lineLimit(1)
								Image(systemName: "xmark").imageScale(.small)
							}
							.font(.subheadline)
							.padding(.horizontal, 10).padding(.vertical, 5)
							.background(valid ? Color(.secondarySystemFill) : Color.red.opacity(0.18), in: Capsule())
							.foregroundStyle(valid ? Color.primary : Color.red)
						}
						.buttonStyle(.plain)
						// The chip says where the mail really goes, whatever name it shows.
						.accessibilityLabel(Text("\(MailAddress(item).address), remove"))
					}
					TextField("", text: $typed)
						.textContentType(.emailAddress)
						.keyboardType(.emailAddress)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.focused($isFocused)
						.frame(minWidth: 120)
						.onSubmit(commit)
						.onChange(of: typed) { _, value in
							if value.hasSuffix(",") || value.hasSuffix(";") || (value.hasSuffix(" ") && ComposeModel.isValid(value.trimmingCharacters(in: .whitespaces))) { commit() }
						}
						.onChange(of: isFocused) { _, focused in if !focused { commit() } }
						.accessibilityIdentifier(identifier)
						.accessibilityLabel(title)
				}
			}
			let suggestions = isFocused ? suggest(typed) : []
			if !suggestions.isEmpty {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(suggestions, id: \.email) { candidate in
						Button {
							entries.append(entry(candidate))
							typed = ""
							Haptics.play(.selection)
						} label: {
							VStack(alignment: .leading, spacing: 1) {
								if let name = candidate.name, !name.isEmpty { Text(name) }
								Text(candidate.email).font(.footnote).foregroundStyle(.secondary)
							}
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(.vertical, 6)
						}
						.buttonStyle(.plain)
						Divider()
					}
				}
				.padding(.leading, 42)
			}
		}
	}
}

/// Lays chips out in rows and starts a new row when one is full.
struct FlowLayout: Layout {
	var spacing: CGFloat = 6

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let rows = arrange(subviews, width: proposal.width ?? .infinity)
		return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		for row in arrange(subviews, width: bounds.width) {
			for item in row.items {
				subviews[item.index].place(at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y), proposal: ProposedViewSize(width: item.width, height: row.height))
			}
		}
	}

	private struct Row { var items: [(index: Int, x: CGFloat, width: CGFloat)] = []; var y: CGFloat = 0; var height: CGFloat = 0; var width: CGFloat = 0 }

	private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
		var rows: [Row] = [Row()]
		for (index, subview) in subviews.enumerated() {
			let ideal = subview.sizeThatFits(.unspecified)
			let itemWidth = min(ideal.width, width)
			if rows[rows.count - 1].width + itemWidth > width, !rows[rows.count - 1].items.isEmpty {
				let last = rows[rows.count - 1]
				rows.append(Row(y: last.y + last.height + spacing))
			}
			var row = rows[rows.count - 1]
			// The field for typing takes what is left of its row.
			let isLast = index == subviews.count - 1
			let x = row.width
			let used = isLast ? max(itemWidth, width - x) : itemWidth
			row.items.append((index, x, used))
			row.width = x + used + spacing
			row.height = max(row.height, ideal.height)
			rows[rows.count - 1] = row
		}
		return rows
	}
}
