import { prepareEmailHtml } from "@/lib/email/html";
import { wrapLongTokens } from "./long-tokens";

export type PrintableMessage = {
	subject: string;
	/** Header lines above the body, already translated: label and value. */
	headers: readonly { label: string; value: string }[];
	html?: string | null;
	text?: string | null;
};

const ROOT_ID = "mailflare-print-root";
const ACTIVE_CLASS = "mailflare-printing";
/** How long a printout waits for the pictures attached to the message. */
const PICTURE_WAIT_MS = 3000;
/** The width a message is fitted to before the paper is known: what A4 and Letter leave inside ordinary margins. */
const PAPER_WIDTH_PX = 680;
/** Below this a printout is no longer read; a table wider still keeps this size and runs off the edge. */
const SMALLEST_PRINT_SCALE = 0.3;

/**
 * Prints one message: its subject, who it is from and to, and its body, without
 * the application around it. The page is built beside the app and shown only
 * to the printer (the `mailflare-printing` rules in globals.css), which works
 * where printing a frame does not (iOS). The body is the same sanitised HTML the
 * reader shows, in a shadow root of its own: its styles neither reach the
 * heading lines above it nor the application. Pictures on the web are not
 * fetched for a printout; pictures that came with the message are waited for.
 */
export function printMessage(message: PrintableMessage): void {
	document.getElementById(ROOT_ID)?.remove();
	const host = document.createElement("div");
	host.id = ROOT_ID;
	const root = host.attachShadow({ mode: "open" });

	const style = document.createElement("style");
	const header = document.createElement("header");
	const title = document.createElement("h1");
	title.textContent = message.subject;
	header.appendChild(title);
	const list = document.createElement("dl");
	for (const { label, value } of message.headers) {
		if (!value) continue;
		const term = document.createElement("dt"), detail = document.createElement("dd");
		term.textContent = label;
		detail.textContent = value;
		list.appendChild(term);
		list.appendChild(detail);
	}
	header.appendChild(list);

	const body = document.createElement("main");
	let mailBody: HTMLElement | null = null;
	const pictures: HTMLImageElement[] = [];
	if (message.html) {
		const prepared = prepareEmailHtml(message.html, { reader: true, allowRemote: false });
		const content = document.createElement("template");
		content.innerHTML = prepared.html;
		// As in the reader: words whole, so a table's columns keep their width on paper too.
		wrapLongTokens(content.content);
		for (const picture of Array.from(content.content.querySelectorAll("img"))) {
			// A picture below the fold of a page nobody scrolls would never load lazily.
			picture.setAttribute("loading", "eager");
			if (picture.getAttribute("src")) pictures.push(picture);
		}
		// A message's own `header { display: none }` or `h1 { ... }` must not touch the lines above.
		const mail = document.createElement("div");
		const mailStyle = document.createElement("style");
		mailStyle.textContent = `:host{display:block;color-scheme:light;overflow-wrap:break-word}img,table{max-width:100%!important}table{min-width:0!important}a{color:inherit}${prepared.rootTag},${prepared.bodyTag}{display:block}`;
		mail.attachShadow({ mode: "open" }).replaceChildren(mailStyle, content.content);
		body.appendChild(mail);
		mailBody = mail;
	} else {
		const text = document.createElement("pre");
		text.textContent = message.text ?? "";
		body.appendChild(text);
	}
	style.textContent = `:host{display:block;color:#000;background:#fff;color-scheme:light;font:12pt/1.45 Arial,Helvetica,sans-serif}
header{border-bottom:1px solid #999;margin:0 0 14pt;padding:0 0 8pt}
h1{font-size:15pt;margin:0 0 8pt;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2pt 10pt;margin:0;font-size:10pt}
dt{color:#444}dd{margin:0;overflow-wrap:anywhere}
main{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;margin:0}`;
	root.replaceChildren(style, header, body);

	const finish = () => {
		window.removeEventListener("afterprint", finish);
		media?.removeEventListener?.("change", onPaper);
		document.documentElement.classList.remove(ACTIVE_CLASS);
		host.remove();
	};
	document.body.appendChild(host);
	document.documentElement.classList.add(ACTIVE_CLASS);
	window.addEventListener("afterprint", finish);
	/**
	 * A table whose columns cannot get narrower (ten headings that do not wrap) is wider than the paper
	 * whatever its width says, and paper cannot be scrolled: the message is made smaller until its last
	 * column, usually the total, is on the page.
	 */
	const fit = (paper: number) => {
		if (!mailBody || !(paper > 0)) return;
		mailBody.style.removeProperty("zoom");
		const needed = mailBody.scrollWidth;
		if (needed > paper + 1) mailBody.style.setProperty("zoom", String(Math.max(SMALLEST_PRINT_SCALE, Math.floor((paper / needed) * 1000) / 1000)));
	};
	/** Fitted before printing, to the usual paper: the printout is not laid out on screen, so it is measured aside. */
	const fitToUsualPaper = () => {
		host.style.cssText = `display:block;position:absolute;left:-10000px;top:0;width:${PAPER_WIDTH_PX}px;visibility:hidden`;
		fit(PAPER_WIDTH_PX);
		host.style.cssText = "";
	};
	// And again to the paper itself where the browser lays the printout out before it asks (narrower paper, wide margins).
	const media = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
	const onPaper = (event: MediaQueryListEvent) => { if (event.matches && document.getElementById(ROOT_ID) === host) fit(host.clientWidth); };
	media?.addEventListener?.("change", onPaper);
	const print = () => {
		if (document.getElementById(ROOT_ID) !== host) return;
		fitToUsualPaper();
		try { window.print(); } catch { finish(); return; }
		// Browsers that return from print() without ever reporting `afterprint` must not keep the page hidden.
		setTimeout(() => { if (document.getElementById(ROOT_ID) === host && !window.matchMedia("print").matches) finish(); }, 60_000);
	};
	const waiting = pictures.filter((picture) => !picture.complete);
	if (waiting.length === 0) { print(); return; }
	// The message's own pictures, a few seconds at most: a missing one must not hold the printout back.
	let left = waiting.length, started = false;
	const start = () => { if (!started) { started = true; print(); } };
	const settled = () => { if (--left === 0) start(); };
	for (const picture of waiting) { picture.addEventListener("load", settled, { once: true }); picture.addEventListener("error", settled, { once: true }); }
	setTimeout(start, PICTURE_WAIT_MS);
}
