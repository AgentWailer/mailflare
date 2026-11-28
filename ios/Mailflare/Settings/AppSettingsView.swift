import SwiftUI
import UserNotifications
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
	@State private var devices: [SignedInDevice]?
	@State private var devicesError: String?
	@State private var deviceToEnd: SignedInDevice?
	@State private var notifications: UNAuthorizationStatus?

	private static let dayChoices = [7, 14, 30, 60, 90]

	private var notificationState: String {
		switch notifications {
		case .authorized, .provisional, .ephemeral: String(localized: "Allowed")
		case .denied: String(localized: "Switched off")
		case .notDetermined: String(localized: "Not asked yet")
		case nil: ""
		@unknown default: ""
		}
	}

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
				LabeledContent("New mail", value: notificationState)
				if notifications == .notDetermined {
					Button("Allow notifications") {
						Task {
							await Notifications.requestPermissionAndRegister()
							notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
						}
					}
				} else if let settings = URL(string: UIApplication.openNotificationSettingsURLString) {
					Link("Open the notification settings of iOS", destination: settings)
				}
			} header: {
				Text("Notifications")
			} footer: {
				Text("A notification shows sender, subject and the first lines. Archive, mark as read and delete work from the notification itself.")
			}
			.task { notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }

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
				if let devices {
					ForEach(devices) { device in
						HStack {
							VStack(alignment: .leading) {
								// Two texts, not one chosen by a condition: only a literal is looked up in the user's language.
								if device.current { Text("\(device.name) (this device)") } else { Text(device.name) }
								Text("Signed in \(device.signedInAt.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary)
							}
							Spacer()
							if !device.current {
								Button("Sign out", role: .destructive) { deviceToEnd = device }.buttonStyle(.borderless)
							}
						}
					}
				} else if let devicesError {
					Label(devicesError, systemImage: "wifi.slash").font(.footnote).foregroundStyle(.secondary)
				} else {
					ProgressView()
				}
			} header: {
				Text("Signed-in devices")
			} footer: {
				Text("Sign a lost phone out here. Revoking its access key in Cloudflare cuts it off as well.")
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
		.task { await loadDevices() }
		.confirmationDialog("Sign this device out?", isPresented: Binding(get: { deviceToEnd != nil }, set: { if !$0 { deviceToEnd = nil } }), titleVisibility: .visible, presenting: deviceToEnd) { device in
			Button("Sign out \(device.name)", role: .destructive) {
				Task {
					try? await session.api.endDevice(id: device.id)
					await loadDevices()
				}
			}
		} message: { _ in
			Text("The device is signed out at once. The mail already on it is removed the next time it reaches the server.")
		}
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

	private func loadDevices() async {
		do {
			devices = try await session.api.devices()
			devicesError = nil
		} catch let error as APIError {
			devicesError = error.userMessage
		} catch {
			devicesError = String(localized: "That did not work. Try again.")
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
