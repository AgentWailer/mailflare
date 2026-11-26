import { prepareEmailHtml } from "@/lib/email/html";

export type PrintableMessage = {
	subject: string;
	/** Header lines above the body, already translated: label and value. */
	headers: readonly { label: string; value: string }[];
	html?: string | null;
	text?: string | null;
};

const ROOT_ID = "mailflare-print-root";
const ACTIVE_CLASS = "mailflare-printing";

/**
 * Prints one message: its subject, who it is from and to, and its body, without
 * the application around it. The page is built beside the app and shown only
 * to the printer (the `mailflare-printing` rules in globals.css), which works
 * where printing a frame does not (iOS). The body is the same sanitised HTML the
 * reader shows, inside a shadow root so its styles stay its own; pictures on
 * the web are not fetched for a printout.
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
	let tags = "";
	if (message.html) {
		const prepared = prepareEmailHtml(message.html, { reader: true, allowRemote: false });
		const content = document.createElement("template");
		content.innerHTML = prepared.html;
		body.appendChild(content.content);
		tags = `${prepared.rootTag},${prepared.bodyTag}{display:block}`;
	} else {
		const text = document.createElement("pre");
		text.textContent = message.text ?? "";
		body.appendChild(text);
	}
	style.textContent = `:host{display:block;color:#000;background:#fff;font:12pt/1.45 Arial,Helvetica,sans-serif}
header{border-bottom:1px solid #999;margin:0 0 14pt;padding:0 0 8pt}
h1{font-size:15pt;margin:0 0 8pt;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2pt 10pt;margin:0;font-size:10pt}
dt{color:#444}dd{margin:0;overflow-wrap:anywhere}
main{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;margin:0}
img,table{max-width:100%!important}a{color:inherit}${tags}`;
	root.replaceChildren(style, header, body);

	const finish = () => {
		window.removeEventListener("afterprint", finish);
		document.documentElement.classList.remove(ACTIVE_CLASS);
		host.remove();
	};
	document.body.appendChild(host);
	document.documentElement.classList.add(ACTIVE_CLASS);
	window.addEventListener("afterprint", finish);
	try { window.print(); } catch { finish(); return; }
	// Browsers that return from print() without ever reporting `afterprint` must not keep the page hidden.
	setTimeout(() => { if (document.getElementById(ROOT_ID) === host && !window.matchMedia("print").matches) finish(); }, 60_000);
}
