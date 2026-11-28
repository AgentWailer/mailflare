import Testing
@testable import Mailflare

@Suite struct AccessKeyParsingTests {
	@Test func `the short form and the JSON form are both accepted`() {
		#expect(parseAccessKey("mailflare-access:abc123.access:s3cr3t") == AccessKey(clientId: "abc123.access", clientSecret: "s3cr3t"))
		#expect(parseAccessKey("  mailflare-access:abc123.access:s3cr3t\n") == AccessKey(clientId: "abc123.access", clientSecret: "s3cr3t"))
		#expect(parseAccessKey(#"{"clientId":"abc123.access","clientSecret":"s3cr3t"}"#) == AccessKey(clientId: "abc123.access", clientSecret: "s3cr3t"))
		#expect(parseAccessKey(#"{"CF-Access-Client-Id":"abc123.access","CF-Access-Client-Secret":"s3cr3t"}"#) == AccessKey(clientId: "abc123.access", clientSecret: "s3cr3t"))
	}

	@Test(arguments: ["", "abc", "mailflare-access:onlyid", "mailflare-access::secret", "mailflare-access:id:", "https://example.test", #"{"clientId":"x"}"#, #"["a","b"]"#, "mailflare-access:id with space:secret"])
	func `anything else is rejected`(text: String) {
		#expect(parseAccessKey(text) == nil)
	}

	@Test func `a server address is completed to https and stripped to its origin`() {
		#expect(normalizeServerAddress("mail.example.test")?.absoluteString == "https://mail.example.test")
		#expect(normalizeServerAddress(" https://mail.example.test/inbox?x=1 ")?.absoluteString == "https://mail.example.test")
		#expect(normalizeServerAddress("http://localhost:3000/")?.absoluteString == "http://localhost:3000")
		#expect(normalizeServerAddress("MAIL.Example.test")?.absoluteString == "https://mail.example.test")
		#expect(normalizeServerAddress("") == nil)
		#expect(normalizeServerAddress("not a host") == nil)
		#expect(normalizeServerAddress("ftp://mail.example.test") == nil)
	}
}
