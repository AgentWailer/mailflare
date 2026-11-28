import SwiftUI

/// The frame the setup steps share: a title, an explanation, the fields and one main button.
struct SetupStep<Fields: View>: View {
	let title: LocalizedStringKey
	let explanation: LocalizedStringKey
	let actionTitle: LocalizedStringKey
	let isActionEnabled: Bool
	let action: () -> Void
	@ViewBuilder var fields: Fields
	@Environment(AppModel.self) private var model

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 20) {
				Text(title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
				Text(explanation).font(.body).foregroundStyle(.secondary)
				fields
				if let error = model.errorMessage {
					Label(error, systemImage: "exclamationmark.triangle.fill")
						.font(.callout)
						.foregroundStyle(.red)
						.accessibilityLabel(Text("Error: \(error)"))
				}
				Button(action: action) {
					HStack {
						if model.isWorking { ProgressView().tint(.white) }
						Text(actionTitle).frame(maxWidth: .infinity)
					}
					.padding(.vertical, 6)
				}
				.buttonStyle(.borderedProminent)
				.disabled(!isActionEnabled || model.isWorking)
			}
			.padding(24)
			.frame(maxWidth: 520)
			.frame(maxWidth: .infinity)
		}
		.scrollDismissesKeyboard(.interactively)
	}
}

struct ServerSetupView: View {
	@Environment(AppModel.self) private var model
	@State private var address = ""

	var body: some View {
		SetupStep(
			title: "Your Mailflare",
			explanation: "Enter the address of your Mailflare installation, the one you open in the browser.",
			actionTitle: "Continue",
			isActionEnabled: !address.trimmingCharacters(in: .whitespaces).isEmpty,
			action: { model.submitServer(address) }
		) {
			TextField("mail.example.com", text: $address)
				.textFieldStyle(.roundedBorder)
				.textContentType(.URL)
				.keyboardType(.URL)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.submitLabel(.continue)
				.onSubmit { model.submitServer(address) }
				.accessibilityLabel("Server address")
		}
		.onAppear { if address.isEmpty, let known = model.serverAddress?.host() { address = known } }
	}
}

struct AccessKeyView: View {
	@Environment(AppModel.self) private var model
	@State private var clientId = ""
	@State private var clientSecret = ""
	@State private var isScanning = false
	/// Set when the view replaces the key of an installation that is already set up.
	var isReplacing = false
	var onDone: () -> Void = {}

	private var key: AccessKey? {
		parseAccessKey("mailflare-access:\(clientId.trimmingCharacters(in: .whitespacesAndNewlines)):\(clientSecret.trimmingCharacters(in: .whitespacesAndNewlines))")
	}

	private func submit() {
		guard let key else { return }
		Task {
			if isReplacing { await model.replaceAccessKey(key) } else { await model.submitAccessKey(key) }
			if model.errorMessage == nil { onDone() }
		}
	}

	/// A pasted or scanned text that holds the whole key fills both fields.
	private func fill(from text: String) -> Bool {
		guard let parsed = parseAccessKey(text) else { return false }
		clientId = parsed.clientId
		clientSecret = parsed.clientSecret
		Haptics.play(.success)
		return true
	}

	var body: some View {
		SetupStep(
			title: "Access key",
			explanation: "This device needs its own Cloudflare Access service token. Create one in Cloudflare Zero Trust and enter its two parts here. They are kept in the keychain of this device only.",
			actionTitle: isReplacing ? "Replace key" : "Check key",
			isActionEnabled: key != nil,
			action: submit
		) {
			VStack(spacing: 12) {
				TextField("Client ID", text: $clientId)
					.textFieldStyle(.roundedBorder)
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
					.onChange(of: clientId) { _, value in _ = fill(from: value) }
				SecureField("Client Secret", text: $clientSecret)
					.textFieldStyle(.roundedBorder)
					.onChange(of: clientSecret) { _, value in _ = fill(from: value) }
				HStack {
					Button("Paste", systemImage: "doc.on.clipboard") {
						if let text = UIPasteboard.general.string, !fill(from: text) { clientSecret = text.trimmingCharacters(in: .whitespacesAndNewlines) }
					}
					Spacer()
					if AccessKeyScanner.isAvailable {
						Button("Scan QR code", systemImage: "qrcode.viewfinder") { isScanning = true }
					}
				}
				.buttonStyle(.bordered)
				if !isReplacing {
					Button("Change server address") { model.backToServer() }
						.font(.callout)
				}
			}
		}
		.sheet(isPresented: $isScanning) {
			AccessKeyScanner { text in
				if fill(from: text) { isScanning = false }
			}
			.ignoresSafeArea()
		}
	}
}

struct SignInView: View {
	@Environment(AppModel.self) private var model
	@State private var email = ""
	@State private var password = ""
	@State private var code = ""
	@FocusState private var focus: Field?

	private enum Field { case email, password, code }

	var body: some View {
		Group {
			if model.needsSecondFactor {
				SetupStep(
					title: "Second factor",
					explanation: "Enter the code from your authenticator app, or one of your recovery codes.",
					actionTitle: "Sign in",
					isActionEnabled: code.trimmingCharacters(in: .whitespaces).count >= 6,
					action: { Task { await model.submitSecondFactor(code: code) } }
				) {
					TextField("Code", text: $code)
						.textFieldStyle(.roundedBorder)
						.textContentType(.oneTimeCode)
						.keyboardType(.asciiCapable)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.font(.title3.monospacedDigit())
						.focused($focus, equals: .code)
						.onSubmit { Task { await model.submitSecondFactor(code: code) } }
					Button("Back") { code = ""; model.cancelSecondFactor() }
						.font(.callout)
				}
				.onAppear { focus = .code }
			} else {
				SetupStep(
					title: model.isAddingAccount ? "Add account" : "Sign in",
					explanation: "Sign in with your Mailflare account. You stay signed in on this device while you use it.",
					actionTitle: "Sign in",
					isActionEnabled: email.contains("@") && !password.isEmpty,
					action: { Task { await model.signIn(email: email, password: password) } }
				) {
					VStack(spacing: 12) {
						TextField("E-mail address", text: $email)
							.textFieldStyle(.roundedBorder)
							.textContentType(.username)
							.keyboardType(.emailAddress)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.focused($focus, equals: .email)
							.submitLabel(.next)
							.onSubmit { focus = .password }
						SecureField("Password", text: $password)
							.textFieldStyle(.roundedBorder)
							.textContentType(.password)
							.focused($focus, equals: .password)
							.submitLabel(.go)
							.onSubmit { Task { await model.signIn(email: email, password: password) } }
						if model.isAddingAccount {
							Button("Cancel") { model.cancelAddingAccount() }.font(.callout)
						}
					}
				}
			}
		}
		.onChange(of: model.phase) { _, _ in password = ""; code = "" }
	}
}
