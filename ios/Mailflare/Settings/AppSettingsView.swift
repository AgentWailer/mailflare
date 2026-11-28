import SwiftUI
import MailflareKit

/// What is set on this device: how much mail it keeps, how it feels, how it reaches the
/// installation and which accounts are signed in. Mailflare's own settings open as the web page.
struct AppSettingsView: View {
	let session: AccountSession
	@Environment(AppModel.self) private var model
	@AppStorage(Haptics.settingKey) private var haptics = true
	@AppStorage("list.conversations") private var conversations = true
	@State private var days = 30
	@State private var autoAttachments = true
	@State private var wifiOnly = true
	@State private var isReplacingKey = false
	@State private var accountToSignOut: AccountCredentials?

	private static let dayChoices = [7, 14, 30, 60, 90]

	var body: some View {
		Form {
			Section {
				Picker("Keep mail offline", selection: $days) {
					ForEach(Self.dayChoices, id: \.self) { Text("\($0) days").tag($0) }
				}
				Toggle("Fetch attachments up to 5 MB", isOn: $autoAttachments)
				Toggle("Only on Wi-Fi", isOn: $wifiOnly).disabled(!autoAttachments)
			} header: {
				Text("Offline")
			} footer: {
				Text("Mail from this period is on the device with its content. Older mail and larger attachments load when you open them.")
			}

			Section("Reading") {
				Toggle("Group conversations", isOn: $conversations)
				Toggle("Haptic feedback", isOn: $haptics)
			}

			Section {
				LabeledContent("Server", value: session.api.access.baseURL.host() ?? "")
				LabeledContent("Access key", value: session.api.access.accessClientId)
				Button("Replace access key") { isReplacingKey = true }
			} header: {
				Text("Access")
			} footer: {
				Text("If a key was revoked in Cloudflare, enter this device's new one here. Accounts and mail stay.")
			}

			Section("Accounts") {
				ForEach(model.accounts) { account in
					HStack {
						VStack(alignment: .leading) {
							Text(account.name.isEmpty ? account.email : account.name)
							Text(account.email).font(.caption).foregroundStyle(.secondary)
						}
						Spacer()
						Button("Sign out", role: .destructive) { accountToSignOut = account }
							.buttonStyle(.borderless)
					}
				}
				Button("Add account", systemImage: "plus") { model.beginAddingAccount() }
			}

			Section {
				NavigationLink(value: Route.web(.settings)) { Label("Mailflare settings", systemImage: "slider.horizontal.3") }
			} footer: {
				Text("Signature, rules, security and everything else that belongs to your account opens as the web page for now.")
			}

			Section {
				LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
			}
		}
		.navigationTitle("Settings")
		.onAppear(perform: load)
		.onChange(of: days) { _, value in save(SettingKey.offlineDays, String(value)) }
		.onChange(of: autoAttachments) { _, value in save(SettingKey.autoAttachments, value ? "1" : "0") }
		.onChange(of: wifiOnly) { _, value in save(SettingKey.attachmentsWiFiOnly, value ? "1" : "0") }
		.sheet(isPresented: $isReplacingKey) {
			NavigationStack {
				AccessKeyView(isReplacing: true) { isReplacingKey = false }
					.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.errorMessage = nil; isReplacingKey = false } } }
			}
		}
		.confirmationDialog("Sign out?", isPresented: Binding(get: { accountToSignOut != nil }, set: { if !$0 { accountToSignOut = nil } }), titleVisibility: .visible, presenting: accountToSignOut) { account in
			Button("Sign out and remove mail", role: .destructive) { Task { await model.signOut(userId: account.userId) } }
		} message: { account in
			Text("The mail of \(account.email) is removed from this device. It stays on the server.")
		}
	}

	private func load() {
		let settings = model.syncSettings(for: session.store)
		days = Self.dayChoices.contains(settings.days) ? settings.days : 30
		autoAttachments = settings.autoAttachmentBytes > 0
		wifiOnly = settings.attachmentsOnWiFiOnly
	}

	/// Stores the setting and rebuilds the sync, which reads its settings when it is created.
	private func save(_ key: String, _ value: String) {
		guard (try? session.store.setting(key)) != value else { return }
		try? session.store.setSetting(key, value)
		model.reloadSession()
	}
}
