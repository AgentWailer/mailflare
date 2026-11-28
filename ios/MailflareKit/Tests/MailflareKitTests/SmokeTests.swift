import Testing
@testable import MailflareKit

@Test func `the package reports its version`() {
	#expect(MailflareKit.version == "0.1.0")
}
