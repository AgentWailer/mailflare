# Mailflare for iOS

The native iPhone app. Design: `docs/superpowers/specs/2026-11-28-ios-app-design.md`.
Setup of Cloudflare Access and the first start are described in `docs/ios-app.md`.

- `MailflareKit/` is a Swift package with access, sync and the on-device store. It has no user interface and is tested on the Mac.
- `Mailflare/` is the SwiftUI app. It reads only from the on-device store.
- `Mailflare.xcodeproj` is generated from `project.yml`. After adding or removing files run `xcodegen generate --spec ios/project.yml` and commit the result.

Xcode's command line tools are used through `DEVELOPER_DIR`, so `xcode-select` need not be changed:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
(cd ios/MailflareKit && swift test)
xcodebuild -project ios/Mailflare.xcodeproj -scheme Mailflare \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/DerivedData test
```

The bundle identifier `de.stepo.mailflare` and the empty development team in `project.yml` are placeholders until the values from the developer account are entered.
