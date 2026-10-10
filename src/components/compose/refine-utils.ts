import { htmlToPlainText, textToHtml, escapeHtml } from "./rich-text-utils";

const PROTECTED = "[data-mailflare-signature], [data-mailflare-quote]";
export type RefineTarget = {
	scope: "selection" | "message";
	range: Range;
	startNode: Node;
	endNode: Node;
	snapshot: string;
	text: string;
	leadingWhitespace: string;
	trailingWhitespace: string;
	images: Array<{ token: string; html: string }>;
};

/** Capture the selection before opening a dialog; signatures and folded quotes stay outside it. */
export function captureRefineTarget(editor: HTMLElement, scope: RefineTarget["scope"], selection: Selection | null): RefineTarget | null {
	const range = editor.ownerDocument.createRange();
	if (scope === "selection") {
		if (!selection?.rangeCount || selection.isCollapsed) return null;
		const selected = selection.getRangeAt(0);
		if (!editor.contains(selected.startContainer) || !editor.contains(selected.endContainer)) return null;
		range.setStart(selected.startContainer, selected.startOffset);
		range.setEnd(selected.endContainer, selected.endOffset);
		if (Array.from(editor.querySelectorAll(PROTECTED)).some(node => range.intersectsNode(node))) return null;
	} else {
		range.selectNodeContents(editor);
		const preserved = editor.querySelector(PROTECTED);
		if (preserved) range.setEndBefore(preserved);
	}
	const copy = editor.ownerDocument.createElement("div");
	copy.appendChild(range.cloneContents());
	const images: RefineTarget["images"] = [];
	const nonce = crypto.randomUUID();
	for (const image of Array.from(copy.querySelectorAll("img"))) {
		const token = `[[MAILFLARE_IMAGE_${nonce}_${images.length}]]`;
		images.push({ token, html: image.outerHTML });
		image.replaceWith(editor.ownerDocument.createTextNode(`\n${token}\n`));
	}
	const text = htmlToPlainText(copy.innerHTML).trim();
	if (!text || !text.replace(/\[\[MAILFLARE_IMAGE_[a-f0-9-]+_\d+\]\]/g, "").trim()) return null;
	const selectedText = range.toString();
	const leadingWhitespace = scope === "selection" ? selectedText.match(/^\s*/)?.[0] ?? "" : "";
	const trailingWhitespace = scope === "selection" ? selectedText.match(/\s*$/)?.[0] ?? "" : "";
	return { scope, range, leadingWhitespace, trailingWhitespace, startNode: range.startContainer, endNode: range.endContainer, snapshot: editor.innerHTML, text, images };
}

/** Model output is always escaped; only original image nodes can become markup again. */
export function refinedHtml(target: RefineTarget, text: string): string | null {
	const tokens = text.match(/\[\[MAILFLARE_IMAGE_[a-f0-9-]+_\d+\]\]/g) ?? [];
	if (!text.trim() || tokens.length !== target.images.length || tokens.some((token, i) => token !== target.images[i].token)) return null;
	let html = target.scope === "message" ? textToHtml(text) : escapeHtml(target.leadingWhitespace + text.trim() + target.trailingWhitespace).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
	for (const image of target.images) html = html.replace(image.token, () => image.html);
	return html;
}

/** Refuse to overwrite changes made while the suggestion was being generated. */
export function applyRefinement(editor: HTMLElement, target: RefineTarget, text: string): boolean {
	if (editor.innerHTML !== target.snapshot || !editor.contains(target.startNode) || !editor.contains(target.endNode) || target.range.startContainer !== target.startNode || target.range.endContainer !== target.endNode) return false;
	const html = refinedHtml(target, text);
	if (html === null) return false;
	const fragment = target.range.createContextualFragment(html);
	target.range.deleteContents();
	target.range.insertNode(fragment);
	return true;
}

/** Render the proposal in a detached copy. Autosave and sending still see the original. */
export function previewRefinement(editor: HTMLElement, target: RefineTarget, text: string): string | null {
	if (editor.innerHTML !== target.snapshot || !editor.contains(target.startNode) || !editor.contains(target.endNode)) return null;
	const copy = editor.cloneNode(true) as HTMLElement;
	function copiedNode(node: Node): Node | null {
		const path: number[] = [];
		while (node !== editor) {
			const parent = node.parentNode;
			if (!parent) return null;
			path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
			node = parent;
		}
		let result: Node = copy;
		for (const index of path) result = result.childNodes[index];
		return result;
	}
	const startNode = copiedNode(target.startNode);
	const endNode = copiedNode(target.endNode);
	if (!startNode || !endNode || target.range.startContainer !== target.startNode || target.range.endContainer !== target.endNode) return null;
	const range = editor.ownerDocument.createRange();
	range.setStart(startNode, target.range.startOffset);
	range.setEnd(endNode, target.range.endOffset);
	return applyRefinement(copy, { ...target, range, startNode, endNode }, text) ? copy.innerHTML : null;
}
