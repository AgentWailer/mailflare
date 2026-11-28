// swift-tools-version: 6.2
import PackageDescription

let package = Package(
	name: "MailflareKit",
	defaultLocalization: "en",
	platforms: [.iOS(.v26), .macOS(.v26)],
	products: [
		.library(name: "MailflareKit", targets: ["MailflareKit"]),
	],
	dependencies: [
		.package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
	],
	targets: [
		.target(
			name: "MailflareKit",
			dependencies: [.product(name: "GRDB", package: "GRDB.swift")]
		),
		.testTarget(
			name: "MailflareKitTests",
			dependencies: ["MailflareKit"],
			resources: [.copy("Fixtures")]
		),
	],
	swiftLanguageModes: [.v6]
)
