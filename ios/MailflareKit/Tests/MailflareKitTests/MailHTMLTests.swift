import Foundation
import Testing
@testable import MailflareKit

@Suite struct MailHTMLTests {
	private func render(_ html: String?, text: String? = nil, remote: Bool = false, inline: [String: String] = [:]) -> MailHTML.Document {
		MailHTML.document(html: html, text: text, snippet: "Snippet", allowRemoteContent: remote, inlineImages: inline)
	}

	@Test func `scripts, frames, forms and other active content are removed`() {
		let page = render("""
			<p onclick="steal()" ONMOUSEOVER = 'x()'>Hello</p><script>alert(1)</script><SCRIPT src="https://evil.example/x.js"></SCRIPT>
			<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">
			<form action="https://evil.example"><input name="password"><button>Send</button></form>
			<meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/a.css"><base href="https://evil.example/">
			<scr<script>ipt>alert(2)</scr</script>ipt>
			""").html
		let lowered = page.lowercased()
		for forbidden in ["<script", "<iframe", "<object", "<embed", "<form", "<input", "<button", "http-equiv=\"refresh\"", "<link", "<base", "onclick", "onmouseover", "alert(1)"] {
			#expect(!lowered.contains(forbidden), "\(forbidden) survived")
		}
		#expect(page.contains("Hello"))
	}

	@Test func `dangerous link targets are neutralised and ordinary ones survive`() {
		let page = render("""
			<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href='data:text/html,<script>1</script>'>c</a><a href="vbscript:x">d</a>
			<a href="https://example.org/path?a=1&amp;b=2">ok</a><a href="mailto:anna@example.org">mail</a><a href="tel:+491234">tel</a>
			""").html
		let lowered = page.lowercased()
		#expect(!lowered.contains("javascript:"))
		#expect(!lowered.contains("vbscript:"))
		#expect(!lowered.contains("data:text/html"))
		#expect(page.contains("href=\"https://example.org/path?a=1&amp;b=2\""))
		#expect(page.contains("mailto:anna@example.org"))
		#expect(page.contains("tel:+491234"))
	}

	@Test func `remote images are held back until allowed and embedded ones always show`() {
		let source = """
			<img src="https://track.example/pixel.gif" width="1"><img src='http://cdn.example/logo.png' alt="Logo" srcset="https://cdn.example/a.png 2x">
			<img src="data:image/png;base64,AAAA"><img src="cid:logo@mail"><td background="https://cdn.example/bg.png" style="background:url(https://cdn.example/bg2.png)">x</td>
			"""
		let blocked = render(source, inline: ["logo@mail": "data:image/png;base64,BBBB"])
		#expect(blocked.blockedRemoteContent == true)
		#expect(!blocked.html.contains("track.example"))
		#expect(!blocked.html.contains("cdn.example"))
		#expect(blocked.html.contains("data:image/png;base64,AAAA"))
		#expect(blocked.html.contains("data:image/png;base64,BBBB"))
		#expect(!blocked.html.contains("cid:"))
		#expect(blocked.html.contains("alt=\"Logo\""))

		let allowed = render(source, remote: true)
		#expect(allowed.blockedRemoteContent == false)
		#expect(allowed.html.contains("https://track.example/pixel.gif"))
		#expect(allowed.html.contains("http://cdn.example/logo.png"))
	}

	@Test func `a mail without remote content reports nothing held back`() {
		#expect(render("<p>Hello <a href=\"https://example.org\">link</a></p>").blockedRemoteContent == false)
	}

	@Test func `the page forbids everything except styles and the images it may show`() throws {
		let blocked = render("<p>x</p>").html
		let policy = try #require(blocked.firstMatch(of: /Content-Security-Policy" content="([^"]+)"/)?.1)
		#expect(policy.contains("default-src 'none'"))
		#expect(policy.contains("img-src data:;"))
		#expect(policy.contains("style-src 'unsafe-inline'"))
		#expect(policy.contains("form-action 'none'"))
		#expect(!policy.contains("script-src") || policy.contains("script-src 'none'"))
		let allowed = render("<p>x</p>", remote: true).html
		#expect(allowed.contains("img-src data: https: http:;"))
		#expect(blocked.contains("<meta name=\"viewport\""))
	}

	@Test func `the sender's own page skeleton and styles do not break out of ours`() {
		let page = render("<html><head><title>T</title><style>p{color:red} @import url(https://evil.example/a.css);</style></head><body bgcolor=\"#fff\"><p>Body</p></body></html>").html
		#expect(page.components(separatedBy: "<body").count == 2, "exactly one body")
		#expect(page.components(separatedBy: "<html").count == 2)
		#expect(page.contains("p{color:red}"))
		#expect(!page.contains("@import"))
		#expect(!page.contains("<title>T"))
	}

	@Test func `plain text is escaped, keeps its lines and turns addresses of pages into links`() {
		let page = render(nil, text: "Hello <b>Anna</b> & co\nSecond line\nSee https://example.org/a?b=1&c=2.").html
		#expect(page.contains("Hello &lt;b&gt;Anna&lt;/b&gt; &amp; co"))
		#expect(page.contains("white-space: pre-wrap") || page.contains("white-space:pre-wrap"))
		#expect(page.contains("<a href=\"https://example.org/a?b=1&amp;c=2\">https://example.org/a?b=1&amp;c=2</a>."))
	}

	@Test func `a mail without any body shows its snippet`() {
		#expect(render(nil, text: nil).html.contains("Snippet"))
		#expect(render("   ", text: "").html.contains("Snippet"))
	}

	@Test func `our own quote marker is folded and other mail stays whole`() {
		let own = "<p>Reply</p><div class=\"mailflare-quote\" data-mailflare-quote=\"1\"><p>On Monday Anna wrote:</p><blockquote>Original</blockquote></div>"
		let split = QuoteSplitter.split(html: own)
		#expect(split.visible == "<p>Reply</p>")
		#expect(split.quoted == "<p>On Monday Anna wrote:</p><blockquote>Original</blockquote>")
		let foreign = "<p>Reply</p><blockquote type=\"cite\">Original</blockquote>"
		#expect(QuoteSplitter.split(html: foreign).visible == foreign)
		#expect(QuoteSplitter.split(html: foreign).quoted == nil)
		#expect(QuoteSplitter.split(html: "").quoted == nil)
	}
}
