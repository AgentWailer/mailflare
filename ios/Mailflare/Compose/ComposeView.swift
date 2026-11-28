import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import MailflareKit

/// Opens the composer from anywhere in the app.
@Observable
final class ComposeCoordinator {
	var intent: ComposeIntent?
}

struct ComposeView: View {
	@State private var model: ComposeModel
	@State private var showsCopies = false
	@State private var isAskingToKeep = false
	@State private var isPickingFiles = false
	@State private var pickedPhotos: [PhotosPickerItem] = []
	@State private var isPickingPhotos = false
	@State private var attachmentProblem: String?
	@Environment(\.dismiss) private var dismiss

	init(intent: ComposeIntent, session: AccountSession) {
		_model = State(initialValue: ComposeModel(intent: intent, session: session))
	}

	private var title: LocalizedStringKey {
		switch model.kind {
		case .reply: "Reply"
		case .forward: "Forward"
		default: "New message"
		}
	}

	private func close() {
		if model.hasContent { isAskingToKeep = true } else { model.discard(); dismiss() }
	}

	private func send() {
		Task {
			if await model.send() {
				Haptics.play(.success)
				dismiss()
			} else {
				Haptics.play(.error)
			}
		}
	}

	private func attach(_ url: URL, type: String) {
		do {
			try model.attach(fileAt: url, type: type)
		} catch ComposeModel.AttachmentError.tooLarge {
			attachmentProblem = String(localized: "This file is larger than 10 MB and cannot be attached.")
		} catch ComposeModel.AttachmentError.tooMany {
			attachmentProblem = String(localized: "A message can carry ten attachments at most.")
		} catch {
			attachmentProblem = String(localized: "This file could not be read.")
		}
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 0) {
					if let error = model.loadError {
						Label(error, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.red).padding(.bottom, 8)
					}
					RecipientField(title: "To", identifier: "compose.to", entries: $model.to, suggest: model.suggestions(for:), entry: model.entry(for:))
						.padding(.vertical, 8)
					Divider()
					if showsCopies || !model.cc.isEmpty || !model.bcc.isEmpty {
						RecipientField(title: "Cc", identifier: "compose.cc", entries: $model.cc, suggest: model.suggestions(for:), entry: model.entry(for:)).padding(.vertical, 8)
						Divider()
						RecipientField(title: "Bcc", identifier: "compose.bcc", entries: $model.bcc, suggest: model.suggestions(for:), entry: model.entry(for:)).padding(.vertical, 8)
						Divider()
					}
					HStack {
						Text("From").foregroundStyle(.secondary).frame(minWidth: 34, alignment: .leading)
						if model.senders.count > 1 {
							Picker("From", selection: $model.from) {
								ForEach(model.senders) { Text($0.address).tag($0.address) }
							}
							.labelsHidden()
							.tint(.primary)
						} else {
							Text(model.from)
						}
						Spacer()
						if !showsCopies && model.cc.isEmpty && model.bcc.isEmpty {
							Button("Cc/Bcc") { withAnimation { showsCopies = true } }.font(.subheadline)
						}
					}
					.padding(.vertical, 8)
					Divider()
					TextField("Subject", text: $model.subject)
						.font(.headline)
						.padding(.vertical, 10)
						.accessibilityIdentifier("compose.subject")
					Divider()
					RichTextEditor(text: $model.body)
						.frame(minHeight: 160)
					if !model.attachments.isEmpty || model.forwardsAttachments { attachments }
					if model.hasQuote {
						Toggle(isOn: $model.includesQuote) {
							Label("Include the earlier message", systemImage: "text.quote")
						}
						.font(.subheadline)
						.padding(.vertical, 10)
					}
				}
				.padding(.horizontal, 16)
			}
			.scrollDismissesKeyboard(.interactively)
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: close) }
				ToolbarItem(placement: .topBarTrailing) {
					Menu {
						Button("Photo or video", systemImage: "photo") { isPickingPhotos = true }
						Button("File", systemImage: "doc") { isPickingFiles = true }
					} label: {
						Label("Attach", systemImage: "paperclip")
					}
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(action: send) { Label("Send", systemImage: "paperplane.fill") }
						.disabled(!model.canSend)
				}
			}
			.overlay { if model.isLoading { ProgressView() } }
			.task { await model.load() }
			.confirmationDialog("Keep this message?", isPresented: $isAskingToKeep, titleVisibility: .visible) {
				Button("Save as draft") { model.saveDraft(); dismiss() }
				Button("Discard", role: .destructive) { model.discard(); dismiss() }
			}
			.alert("Attachment", isPresented: Binding(get: { attachmentProblem != nil }, set: { if !$0 { attachmentProblem = nil } })) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(attachmentProblem ?? "")
			}
			.fileImporter(isPresented: $isPickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
				guard case .success(let urls) = result else { return }
				for url in urls {
					let scoped = url.startAccessingSecurityScopedResource()
					attach(url, type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
					if scoped { url.stopAccessingSecurityScopedResource() }
				}
			}
			.photosPicker(isPresented: $isPickingPhotos, selection: $pickedPhotos, maxSelectionCount: ComposeModel.maxAttachments, matching: .any(of: [.images, .videos]))
			.onChange(of: pickedPhotos) { _, items in
				guard !items.isEmpty else { return }
				pickedPhotos = []
				Task {
					for item in items {
						guard let data = try? await item.loadTransferable(type: Data.self) else {
							attachmentProblem = String(localized: "This file could not be read.")
							continue
						}
						let type = item.supportedContentTypes.first ?? .jpeg
						let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString)/\(String(localized: "Photo")).\(type.preferredFilenameExtension ?? "jpg")")
						try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
						guard (try? data.write(to: file)) != nil else { continue }
						attach(file, type: type.preferredMIMEType ?? "image/jpeg")
						try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
					}
				}
			}
		}
		.interactiveDismissDisabled(model.hasContent)
	}

	private var attachments: some View {
		VStack(alignment: .leading, spacing: 6) {
			ForEach(model.attachments, id: \.self) { attachment in
				HStack {
					Image(systemName: "paperclip")
					Text(attachment.filename).lineLimit(1)
					Spacer()
					Button { model.removeAttachment(attachment) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
						.buttonStyle(.plain)
						.accessibilityLabel(Text("Remove \(attachment.filename)"))
				}
				.font(.subheadline)
				.padding(10)
				.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
			}
			if model.forwardsAttachments {
				Label("The attachments of the original are sent along.", systemImage: "paperclip").font(.footnote).foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 8)
	}
}

/// Messages written on this device that have not gone out: put aside, waiting, or refused.
struct OutboxView: View {
	let session: AccountSession
	@State private var messages: [OutgoingMessage] = []
	@Environment(ComposeCoordinator.self) private var composer

	var body: some View {
		List {
			ForEach(messages) { message in
				Button { composer.intent = .outgoing(id: message.id) } label: {
					VStack(alignment: .leading, spacing: 3) {
						HStack {
							Text(message.to.isEmpty ? String(localized: "No recipient") : message.to.map { MailAddress($0).label }.joined(separator: ", ")).font(.headline).lineLimit(1)
							Spacer()
							state(message.state)
						}
						Text(message.subject.isEmpty ? String(localized: "(No subject)") : message.subject).font(.subheadline).lineLimit(1)
						if case .failed(let reason) = message.state {
							Text("Not sent: \(reason)").font(.footnote).foregroundStyle(.red)
						}
					}
				}
				.buttonStyle(.plain)
				.swipeActions {
					Button("Delete", systemImage: "trash", role: .destructive) {
						try? session.store.deleteOutgoing(id: message.id)
						for attachment in message.attachments { try? FileManager.default.removeItem(at: attachment.file) }
					}
				}
			}
		}
		.overlay { if messages.isEmpty { ContentUnavailableView("Nothing waiting", systemImage: "tray") } }
		.navigationTitle("Outbox")
		.navigationBarTitleDisplayMode(.inline)
		.task { for await messages in session.store.observeOutgoing() { self.messages = messages } }
	}

	@ViewBuilder private func state(_ state: OutgoingMessage.State) -> some View {
		switch state {
		case .draft: Text("Draft").font(.caption).foregroundStyle(.secondary)
		case .queued: Label("Waiting to send", systemImage: "arrow.up.circle").font(.caption).foregroundStyle(.secondary)
		case .failed: Label("Not sent", systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
		}
	}
}
