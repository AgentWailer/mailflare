import SwiftUI
import QuickLook
import MailflareKit

struct MessageView: View {
	let session: AccountSession
	@State private var model: MessageModel
	// Starts small: the page reports its own height, and never less than the view already has.
	@State private var bodyHeight: CGFloat = 24
	@State private var showsRecipients = false
	@State private var prompts = ActionPrompts()
	@State private var tree = MailboxTree()
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@Environment(ComposeCoordinator.self) private var composer

	/// Actions after which there is nothing left to read here.
	private static let leavesReader: Set<RowAction> = [.archive, .trash, .spam, .moveToInbox]

	private func run(_ action: RowAction) {
		let leaves = Self.leavesReader.contains(action)
		prompts.run(action, on: [model.messageId], mailboxId: model.message?.row.mailboxId) { mailAction, _ in
			await model.perform(mailAction)
		}
		if leaves { dismiss() }
	}
	private let words = Presentation.current

	init(messageId: String, session: AccountSession) {
		self.session = session
		_model = State(initialValue: MessageModel(messageId: messageId, session: session))
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				if let row = model.message?.row {
					if !model.earlier.isEmpty { earlier }
					header(row)
					Divider().padding(.horizontal, 16)
					content
					if !model.attachments.isEmpty { attachments }
				} else if model.state == .loading {
					ProgressView().frame(maxWidth: .infinity).padding(40)
				}
				if case .failed(let message) = model.state {
					ContentUnavailableView { Label("Cannot show this message", systemImage: "exclamationmark.triangle") } description: { Text(message) }
				}
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let row = model.message?.row {
				let offer = MailActions.offered(for: row, canManage: MailActions.canManage(mailboxId: row.mailboxId, in: tree))
				// The two things done most are one tap away; everything else is in the menu.
				let quick = Array((offer.leading.filter { $0 != .markRead && $0 != .markUnread } + offer.trailing).prefix(2))
				ToolbarItemGroup(placement: .bottomBar) {
					if row.status != "draft" {
						Menu {
							Button("Reply", systemImage: "arrowshape.turn.up.left") { composer.intent = .reply(messageId: row.id, all: false) }
							if ReplyBuilder.hasAdditionalRecipients(row, ownAddresses: ownAddresses(for: row)) {
								Button("Reply all", systemImage: "arrowshape.turn.up.left.2") { composer.intent = .reply(messageId: row.id, all: true) }
							}
							Button("Forward", systemImage: "arrowshape.turn.up.right") { composer.intent = .forward(messageId: row.id) }
						} label: {
							Label("Reply", systemImage: "arrowshape.turn.up.left")
						} primaryAction: {
							composer.intent = .reply(messageId: row.id, all: false)
						}
						Spacer()
					}
					ForEach(quick, id: \.self) { action in
						RowActionButton(action: action) { run(action) }
						Spacer()
					}
					Menu {
						ForEach(offer.menu.filter { !quick.contains($0) }, id: \.self) { action in
							RowActionButton(action: action) { run(action) }
						}
					} label: {
						Label("More", systemImage: "ellipsis.circle")
					}
				}
			}
		}
		.actionPrompts(prompts, tree: tree, onDone: { dismiss() }) { action, _ in await model.perform(action) }
		.task {
			for await tree in session.store.observeMailboxes() { self.tree = tree }
		}
		.quickLookPreview($model.previewFile)
		.alert("Attachment", isPresented: Binding(get: { model.attachmentError != nil }, set: { if !$0 { model.attachmentError = nil } })) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model.attachmentError ?? "")
		}
		.onAppear { model.start() }
		.onDisappear { model.stop() }
	}

	private func ownAddresses(for row: MessageRow) -> [String] {
		tree.mailboxes.first { $0.id == row.mailboxId }.flatMap { $0.senderAddresses ?? [$0.address] } ?? [session.account.email]
	}

	/// What a `mailto:` link asks for. Only addresses, subject and text are taken from it.
	static func compose(fromMailLink url: URL) -> ComposeIntent {
		let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
		let query = Dictionary((components?.queryItems ?? []).map { ($0.name.lowercased(), $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
		let addresses = MailAddress.list((components?.path ?? "") + (query["to"].map { ",\($0)" } ?? "")).map(\.address).filter(ComposeModel.isValid)
		return .new(to: addresses, subject: query["subject"] ?? "", body: query["body"] ?? "")
	}

	// MARK: Head

	private func header(_ row: MessageRow) -> some View {
		let sender = MailAddress(row.fromAddr)
		return VStack(alignment: .leading, spacing: 10) {
			Text(words.subject(of: row))
				.font(.title2.bold())
				.accessibilityAddTraits(.isHeader)
			HStack(alignment: .top, spacing: 12) {
				Text(initials(row.fromContactName ?? sender.label))
					.font(.subheadline.bold())
					.foregroundStyle(.white)
					.frame(width: 40, height: 40)
					.background(Color.accentColor.gradient, in: Circle())
					.accessibilityHidden(true)
				VStack(alignment: .leading, spacing: 2) {
					HStack(alignment: .firstTextBaseline) {
						Text(row.fromContactName ?? sender.label).font(.headline)
						Spacer()
						Text(words.rowDate(row.createdAt)).font(.subheadline).foregroundStyle(.secondary)
					}
					// The address the mail really came from is always shown: a name alone can be anything.
					Text(sender.address).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
					Button {
						withAnimation { showsRecipients.toggle() }
					} label: {
						HStack(spacing: 4) {
							Text(recipientSummary(row)).lineLimit(1)
							Image(systemName: showsRecipients ? "chevron.up" : "chevron.down").imageScale(.small)
						}
						.font(.footnote)
						.foregroundStyle(.secondary)
					}
					.buttonStyle(.plain)
					if showsRecipients { recipients(row) }
				}
			}
		}
		.padding(16)
	}

	private func recipientSummary(_ row: MessageRow) -> String {
		let names = MailAddress.list(row.toAddr).map(\.label)
		let others = MailAddress.list(row.ccAddr ?? "").count
		let first = names.prefix(2).joined(separator: ", ")
		let more = names.count - min(names.count, 2) + others
		return more > 0 ? words.text("To: %@ and %lld more", first, more) : words.text("To: %@", first)
	}

	private func recipients(_ row: MessageRow) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			addressLine("From", [MailAddress(row.fromAddr)])
			addressLine("To", MailAddress.list(row.toAddr))
			if let cc = row.ccAddr, !cc.isEmpty { addressLine("Cc", MailAddress.list(cc)) }
			if let replyTo = row.replyTo, !replyTo.isEmpty { addressLine("Reply to", MailAddress.list(replyTo)) }
			Text(words.fullDate(row.createdAt))
		}
		.font(.footnote)
		.foregroundStyle(.secondary)
		.padding(.top, 4)
	}

	private func addressLine(_ title: LocalizedStringKey, _ addresses: [MailAddress]) -> some View {
		HStack(alignment: .top, spacing: 6) {
			Text(title).frame(minWidth: 56, alignment: .leading)
			VStack(alignment: .leading, spacing: 2) {
				ForEach(Array(addresses.enumerated()), id: \.offset) { _, address in
					Text(address.name.map { "\($0) <\(address.address)>" } ?? address.address).textSelection(.enabled)
				}
			}
		}
	}

	// MARK: Content

	@ViewBuilder private var content: some View {
		switch model.state {
		case .needsNetwork:
			ContentUnavailableView {
				Label("Not on this device yet", systemImage: "wifi.slash")
			} description: {
				Text("This message loads as soon as you are online again.")
			} actions: {
				Button("Try again") { Task { await model.retry() } }
			}
		case .loading where model.document == nil:
			ProgressView().frame(maxWidth: .infinity).padding(40)
		default:
			if let document = model.document {
				if document.blockedRemoteContent {
					Button {
						Haptics.play(.selection)
						model.allowsRemoteContent = true
					} label: {
						Label("Load pictures from the internet", systemImage: "photo")
							.font(.footnote)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(10)
							.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
					}
					.buttonStyle(.plain)
					.padding(.horizontal, 16)
					.padding(.top, 12)
				}
				MailBodyView(html: document.html, height: $bodyHeight) { url in
					let scheme = url.scheme?.lowercased() ?? ""
					if ["https", "http", "tel"].contains(scheme) { openURL(url) }
					// A mail link starts a message here instead of leaving for another app.
					if scheme == "mailto" { composer.intent = Self.compose(fromMailLink: url) }
				}
				.frame(height: bodyHeight)
				.padding(.top, 12)
				if model.hasQuote {
					Button {
						model.showsQuote.toggle()
					} label: {
						Label(model.showsQuote ? "Hide quoted text" : "Show quoted text", systemImage: "ellipsis.bubble")
							.font(.footnote)
					}
					.buttonStyle(.bordered)
					.padding(.horizontal, 16)
					.padding(.bottom, 12)
				}
			}
		}
	}

	// MARK: Conversation and attachments

	private var earlier: some View {
		VStack(spacing: 0) {
			ForEach(model.earlier) { row in
				NavigationLink(value: Route.message(row.id)) {
					HStack {
						VStack(alignment: .leading, spacing: 2) {
							Text(words.correspondent(of: row)).font(.subheadline.weight(row.read ? .regular : .semibold))
							Text(row.snippet ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
						}
						Spacer()
						Text(words.rowDate(row.createdAt)).font(.footnote).foregroundStyle(.secondary)
						Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
					}
					.padding(.horizontal, 16)
					.padding(.vertical, 10)
				}
				.buttonStyle(.plain)
				Divider().padding(.leading, 16)
			}
		}
		.background(Color(.secondarySystemBackground))
		.accessibilityElement(children: .contain)
		.accessibilityLabel(Text("Other messages of this conversation"))
	}

	private var attachments: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("Attachments").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
			ForEach(model.attachments) { attachment in
				Button {
					Task { await model.open(attachment) }
				} label: {
					HStack(spacing: 12) {
						Image(systemName: symbol(for: attachment.type)).font(.title3).frame(width: 28)
						VStack(alignment: .leading, spacing: 2) {
							Text(attachment.filename).lineLimit(1)
							Text(Int64(attachment.size), format: .byteCount(style: .file)).font(.caption).foregroundStyle(.secondary)
						}
						Spacer()
						if model.loadingAttachmentId == attachment.id { ProgressView() }
					}
					.padding(12)
					.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
				}
				.buttonStyle(.plain)
				.disabled(model.loadingAttachmentId != nil)
			}
		}
		.padding(16)
	}

	private func symbol(for type: String) -> String {
		if type.hasPrefix("image/") { return "photo" }
		if type == "application/pdf" { return "doc.richtext" }
		if type.hasPrefix("audio/") { return "waveform" }
		if type.hasPrefix("video/") { return "film" }
		if type.contains("zip") || type.contains("compressed") { return "doc.zipper" }
		if type.contains("calendar") { return "calendar" }
		return "doc"
	}
}
