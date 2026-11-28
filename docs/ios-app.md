# Mailflare for iOS

The native iPhone app lives in `ios/`. Its design is in
[superpowers/specs/2026-11-28-ios-app-design.md](superpowers/specs/2026-11-28-ios-app-design.md).
This page describes what exists after stage 1 (the foundation) and how to set it up.

## What the app does today

- Signs in through Cloudflare Access with a service token of its own and then with a
  Mailflare account, including the second factor.
- Keeps the mail of the last 30 days on the phone, with content, and the smaller
  attachments. Lists and messages open without a network.
- Shows mailboxes, the folders, the five inbox categories, conversations and messages.
- Opens calendar, Drive, the account's settings and administration as web pages inside
  the app.
- Follows changes while it is on screen, and asks iOS to wake it now and then.

Not built yet, each with its own stage: marking, moving and deleting mail (stage 2),
writing mail (stage 3), notifications from Apple (stage 4), search and TestFlight (stage 5).
Opening a message does not mark it as read until stage 2.

## Before the first start: Cloudflare Access

Mailflare usually sits behind Cloudflare Access. The app cannot use the interactive
sign-in, so each device gets a service token.

1. In Cloudflare Zero Trust open **Access → Service Auth → Service Tokens** and create one
   token per device, named after it. Copy the Client ID and the Client Secret; the secret
   is shown once.
2. Open the Access application that protects Mailflare and add a policy with the action
   **Service Auth** that includes these tokens. Keep the existing policies.
3. If the installation uses Turnstile on its sign-in page, the Worker needs
   `MCP_ACCESS_ISSUER` and `MCP_ACCESS_AUDIENCE` (they are already set where ChatGPT is
   connected). The app's sign-in skips Turnstile and instead requires a signed Access
   assertion. When the app is protected by a different Access application than MCP, set
   `APP_ACCESS_AUDIENCE` to that application's audience tag.

A lost phone is cut off by revoking its token in Cloudflare, or by signing it out under
**Settings → Signed-in devices** in the app on another device. Either one is enough to stop
it. Changing the account's password signs every device and browser out. The web interface
does not list devices yet; that comes with the native settings.

## Server changes the app needs

Apply these migrations before the code that uses them is deployed:

- `0085_mail_changes.sql`: the change log `mail_changes` and its triggers. Every insert,
  delete and list-relevant update of a message adds a row; a nightly job drops rows older
  than 45 days.
- `0086_device_sessions.sql`: `device_sessions`, the device behind an app's session.

New routes, all behind the usual session check:

| Route | Purpose |
| --- | --- |
| `POST /api/app/login`, `POST /api/app/login/mfa` | Sign-in for the app. Returns a device session token (`dev_…`), sets no cookie. |
| `GET /api/app/sync?cursor=&days=&limit=` | First the last `days` in pages, then only what changed since the cursor. |
| `GET /api/app/devices`, `DELETE /api/app/devices/[id]` | The devices signed in to the account, and signing one of them out. |

A device session lasts 90 days and renews itself while it is used. `/api/realtime` accepts
the bearer token as well as the browser cookie.

## First start

1. **Server address**: the address Mailflare is opened at in the browser.
2. **Access key**: Client ID and Client Secret of this device's service token. They can be
   typed, pasted, or scanned as a QR code that contains
   `mailflare-access:<client id>:<client secret>`.
3. **Sign in** with the Mailflare account, then the second factor if it is switched on.

The first sync fetches the last 30 days in pages; the list is usable after the first page.

## What is stored on the phone

| What | Where | Protection |
| --- | --- | --- |
| Access key and session tokens | Keychain | This device only, readable after the first unlock |
| Mail, one database per account | App's Application Support folder | Encrypted by iOS until the first unlock |
| Attachments up to 5 MB from the offline period | Next to the database | Same |

Signing an account out removes its mail from the phone. So does a session the server has
ended. The offline period (7 to 90 days) and the attachment rule are set in the app under
**Settings**.

## Building and testing

Xcode's command line tools are reached through `DEVELOPER_DIR`; `xcode-select` need not be
changed.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
(cd ios/MailflareKit && swift test)
xcodebuild -project ios/Mailflare.xcodeproj -scheme Mailflare \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/DerivedData test
```

- `ios/Mailflare.xcodeproj` is generated: after adding or removing files run
  `xcodegen generate --spec ios/project.yml` and commit the result.
- German texts live in one table, `ios/tools/strings.py`. Run it after changing a text;
  `python3 ios/tools/strings.py --check ios/DerivedData` lists texts without a translation.
- The JSON the Swift tests decode comes from the real routes:
  `node ios/MailflareKit/Tests/MailflareKitTests/Fixtures/generate.mjs`.
- `node ios/tools/local-server.mjs` runs the built Worker over a local database with
  made-up mail for the simulator (`npm run build` first).
- With that server running, the walk-through drives the app through setup, the lists, the
  reader and a start without a connection, and keeps a screenshot of every step:

  ```sh
  TEST_RUNNER_MAILFLARE_UI_SERVER=http://127.0.0.1:8799 xcodebuild test \
    -project ios/Mailflare.xcodeproj -scheme MailflareUI \
    -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/DerivedData \
    -resultBundlePath ios/DerivedData/walkthrough.xcresult
  ```

The app accepts `https` addresses only. A development build also accepts `http` for
`localhost` and `127.0.0.1`, which is how the simulator reaches the local server.

The bundle identifier `de.stepo.mailflare` and the empty development team in
`ios/project.yml` are placeholders until the values from the developer account are entered.
The app icon is the web icon scaled up; it needs a 1024 px version without transparency
before TestFlight.

## What it looks like

Taken by the walk-through in the simulator, with made-up mail:

| Inbox | Message | Newsletter | Mailboxes |
| --- | --- | --- | --- |
| ![Inbox](screenshots/ios/04-inbox.png) | ![A conversation with an attachment](screenshots/ios/05-reader.png) | ![An HTML newsletter with its pictures held back](screenshots/ios/07-newsletter.png) | ![Mailboxes and folders](screenshots/ios/08-mailboxes.png) |

| Without a connection | Devices | Dark | Dark newsletter |
| --- | --- | --- | --- |
| ![The inbox offline](screenshots/ios/12-offline-inbox.png) | ![Signed-in devices](screenshots/ios/11-settings-devices.png) | ![The inbox in dark](screenshots/ios/16-dark-inbox.png) | ![A newsletter in dark](screenshots/ios/18-dark-newsletter.png) |

## What only a real iPhone can show

The simulator and the tests cannot prove these, and none of them has been tried on a device:

- Cloudflare Access with a real service token, for API calls, the realtime connection and
  above all the in-app web pages. Those rely on the cookie Access returns for a
  service-token request reaching every request of the page.
- Haptics.
- Background refresh, which iOS grants as it sees fit.
- Fetching attachments only on Wi-Fi.
- The camera for the QR code.
