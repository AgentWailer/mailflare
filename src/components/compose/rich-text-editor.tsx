"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	Quote,
	RemoveFormatting,
	Strikethrough,
	Underline,
	Sparkles,
	Undo2,
	Type,
} from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmailHtmlRenderer } from "@/components/messages/email-html-renderer";
import { sanitizeEmailHtml, sanitizeEditorHtml } from "@/lib/email/html";
import { RefineControls } from "./refine-controls";
import { captureRefineTarget, applyRefinement, previewRefinement } from "./refine-utils";
import type { RefineTarget } from "./refine-utils";
import type { RefineReplyContext } from "@/lib/agent/refine-input";
import type { RichTextEditorProps, ToolbarCommand } from "./rich-text-editor-types";

const COMMANDS: ToolbarCommand[] = [
	{ command: "bold", labelKey: "editor.bold", icon: Bold },
	{ command: "italic", labelKey: "editor.italic", icon: Italic },
	{ command: "underline", labelKey: "editor.underline", icon: Underline },
	{ command: "strikeThrough", labelKey: "editor.strikethrough", icon: Strikethrough },
	{ command: "insertUnorderedList", labelKey: "editor.bulletedList", icon: List },
	{ command: "insertOrderedList", labelKey: "editor.numberedList", icon: ListOrdered },
	{ command: "formatBlock", labelKey: "editor.quote", icon: Quote, value: "blockquote" },
];

/**
 * A small HTML editor built on contentEditable. It stays deliberately light:
 * inline styles, lists, quotes and links, with pasted content flattened to
 * text so a message never carries another site's markup.
 */
export function RichTextEditor({
	id,
	mailboxId,
	value,
	onChange,
	quotedHtml,
	replyContext,
	disabled,
	placeholder,
	className,
	toolbarStart,
	toolbarEnd,
	footerContent,
	onRefineActiveChange,
}: RichTextEditorProps) {
	const { t } = useLanguage();
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [formattingOpen, setFormattingOpen] = useState(false);
	const [preview, setPreview] = useState<{ html: string; revision: number } | null>(null);
	const pendingSelection = useRef<RefineTarget | null>(null);
	const previewRevision = useRef(0);
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const [refine, setRefine] = useState<{ mailboxId: string; snapshot: string; draftReply: boolean; replyContext?: RefineReplyContext; contextKey: string; selection: RefineTarget | null; message: RefineTarget | null } | null>(null);
	const [refineUndo, setRefineUndo] = useState<{ mailboxId: string; before: string; after: string } | null>(null);
	const savedRange = useRef<Range | null>(null);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (!element) return;
		const safeValue = sanitizeEditorHtml(value);
		if (element.innerHTML !== safeValue) element.innerHTML = safeValue;
		if (refine && (mailboxId !== refine.mailboxId || element.innerHTML !== refine.snapshot || refine.draftReply && JSON.stringify(replyContext) !== refine.contextKey)) { setRefine(null); setPreview(null); }
	}, [value, mailboxId, refine, replyContext]);

	useEffect(() => {
		onRefineActiveChange?.(!!refine);
		return () => onRefineActiveChange?.(false);
	}, [refine, onRefineActiveChange]);

	useEffect(() => {
		function refresh() {
			const element = editorRef.current;
			if (!element || !element.contains(document.activeElement) || !document.queryCommandState) return;
			const next: Record<string, boolean> = {};
			for (const item of COMMANDS) {
				if (item.command === "formatBlock") {
					next[item.command] = document.queryCommandValue("formatBlock").toLowerCase() === "blockquote";
				} else {
					next[item.command] = document.queryCommandState(item.command);
				}
			}
			setActive(next);
		}
		document.addEventListener("selectionchange", refresh);
		return () => document.removeEventListener("selectionchange", refresh);
	}, []);

	function emit() {
		// Export validated original resource addresses, never the blocked preview placeholders.
		onChange(sanitizeEmailHtml(editorRef.current?.innerHTML ?? "", { forOutgoing: true }) ?? "");
	}

	function openRefine() {
		const element = editorRef.current;
		if (!element || !mailboxId) return;
		setLinkOpen(false);
		setPreview(null);
		const selection = pendingSelection.current ?? captureRefineTarget(element, "selection", window.getSelection());
		const message = captureRefineTarget(element, "message", null);
		setRefine({ mailboxId, snapshot: element.innerHTML, draftReply: !selection && !message, replyContext, contextKey: JSON.stringify(replyContext), selection, message: message ?? captureRefineTarget(element, "message", null, true) });
		pendingSelection.current = null;
		element.blur();
	}

	function showRefinePreview(target: RefineTarget | null, text: string | null) {
		if (!target || text === null) { setPreview(null); return true; }
		const element = editorRef.current;
		if (!element || !refine || disabled || mailboxId !== refine.mailboxId) return false;
		const html = previewRefinement(element, target, text);
		if (html === null) return false;
		setPreview({ html, revision: ++previewRevision.current });
		return true;
	}

	function closeRefine() {
		setRefine(null); setPreview(null);
	}

	function applyRefine(target: RefineTarget, text: string) {
		const element = editorRef.current;
		if (!element || !refine || !mailboxId || disabled || mailboxId !== refine.mailboxId || !applyRefinement(element, target, text)) return false;
		setRefineUndo({ mailboxId: refine.mailboxId, before: target.snapshot, after: element.innerHTML });
		emit();
		return true;
	}

	function undoRefine() {
		const element = editorRef.current;
		if (!element || !refineUndo || disabled || mailboxId !== refineUndo.mailboxId || element.innerHTML !== refineUndo.after) { setRefineUndo(null); return; }
		element.innerHTML = refineUndo.before;
		setRefineUndo(null);
		emit();
	}

	function run(command: string, commandValue?: string) {
		if (refine) return;
		editorRef.current?.focus();
		if (command === "formatBlock" && active.formatBlock) {
			document.execCommand("formatBlock", false, "div");
		} else {
			document.execCommand(command, false, commandValue);
		}
		emit();
	}

	function openLink() {
		if (refine) return;
		const selection = window.getSelection();
		savedRange.current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		setLinkUrl("");
		setLinkOpen(true);
	}

	function applyLink() {
		const url = linkUrl.trim();
		setLinkOpen(false);
		if (!url) return;
		const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
		editorRef.current?.focus();
		const selection = window.getSelection();
		if (savedRange.current && selection) {
			selection.removeAllRanges();
			selection.addRange(savedRange.current);
		}
		if (selection && selection.isCollapsed) {
			document.execCommand("insertHTML", false, `<a href="${href.replace(/"/g, "&quot;")}">${href}</a>`);
		} else {
			document.execCommand("createLink", false, href);
		}
		emit();
	}

	function onPaste(event: ClipboardEvent<HTMLDivElement>) {
		event.preventDefault();
		const text = event.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, text);
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openLink();
		}
	}

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
				<div
					ref={editorRef}
					id={id}
					role="textbox"
					aria-multiline="true"
					aria-label={t("editor.messageBody")}
					contentEditable={!disabled && !refine}
					aria-readonly={!!refine || disabled}
					aria-hidden={!!preview}
					inert={!!preview}
					suppressContentEditableWarning
					data-placeholder={placeholder}
					onInput={() => { setRefineUndo(null); emit(); }}
					onBlur={emit}
					onPaste={onPaste}
					onKeyDown={event => { if (event.key === "Escape" && refine) { event.preventDefault(); closeRefine(); } else onKeyDown(event); }}
					className={cn(
						"email-body flex-1 max-w-none break-words px-4 py-3 text-base text-neutral-900 outline-none md:text-sm",
						preview && "hidden",
						"min-h-32 empty:before:pointer-events-none empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]",
						disabled && "cursor-not-allowed opacity-60",
					)}
				/>
				{preview && <div key={preview.revision} role="textbox" aria-readonly="true" aria-multiline="true" aria-label={t("refine.preview")} className="refine-preview email-body min-h-32 flex-1 max-w-none break-words px-4 py-3 text-base text-neutral-900 md:text-sm" dangerouslySetInnerHTML={{ __html: preview.html }} />}
				{quotedHtml && (
					<div className="px-4 pb-3">
						<button
							type="button"
							onClick={() => setShowQuoted((open) => !open)}
							aria-expanded={showQuoted}
							className="rounded-full border border-neutral-200 bg-neutral-100 px-2 text-xs leading-5 text-neutral-500 hover:bg-neutral-200"
							title={showQuoted ? t("editor.hideQuoted") : t("editor.showQuoted")}
						>
							•••
						</button>
						{showQuoted && (
							<EmailHtmlRenderer className="mt-2" html={quotedHtml} preserveLeadingQuote />
						)}
					</div>
				)}
			</div>
			{refine && <RefineControls draftReply={refine.draftReply} replyContext={refine.draftReply ? refine.replyContext : undefined} mailboxId={refine.mailboxId} selection={refine.selection} message={refine.message} onPreview={showRefinePreview} onApply={applyRefine} onClose={closeRefine} />}
			{footerContent}
			<div className="compose-toolbar relative flex shrink-0 flex-wrap items-center gap-0.5 border-t border-neutral-100 bg-white px-3 py-2 md:gap-0.5 md:px-4 md:py-3">
				{mailboxId && <Tooltip label={t("refine.title")}><button type="button" aria-label={t("refine.title")} disabled={disabled || !!refine} onPointerDown={() => { const element = editorRef.current; pendingSelection.current = element ? captureRefineTarget(element, "selection", window.getSelection()) : null; }} onMouseDown={event => event.preventDefault()} onClick={openRefine} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-blue-600 hover:bg-blue-50 disabled:opacity-50 md:h-8 md:w-8"><Sparkles className="h-5 w-5" /></button></Tooltip>}
				{toolbarStart}
				<button type="button" aria-label={t("editor.formatting")} aria-expanded={formattingOpen} disabled={disabled || !!refine} onMouseDown={event => event.preventDefault()} onClick={() => setFormattingOpen(open => !open)} className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 md:hidden", formattingOpen && "bg-neutral-100 text-neutral-900")}><Type className="h-5 w-5" /></button>
				<div className={cn("order-last w-full flex-wrap items-center gap-0.5 border-t border-neutral-100 pt-1 md:order-none md:flex md:w-auto md:border-0 md:pt-0", formattingOpen ? "flex" : "hidden")}>

				{COMMANDS.map((item) => (
					<Tooltip key={item.command} label={t(item.labelKey)}>
						<button
							type="button"
							aria-label={t(item.labelKey)}
							aria-pressed={!!active[item.command]}
							disabled={disabled || !!refine}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => run(item.command, item.value)}
							className={cn(
								"flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 md:h-7 md:w-7",
								active[item.command] && "bg-neutral-200 text-neutral-900",
							)}
						>
							<item.icon className="h-4 w-4" />
						</button>
					</Tooltip>
				))}
				<Tooltip label={t("editor.insertLinkHint")}>
					<button
						type="button"
						aria-label={t("editor.insertLink")}
						disabled={disabled || !!refine}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLink}
						className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 md:h-7 md:w-7"
					>
						<Link2 className="h-4 w-4" />
					</button>
				</Tooltip>
				<Tooltip label={t("editor.clearFormatting")}>
					<button
						type="button"
						aria-label={t("editor.clearFormatting")}
						disabled={disabled || !!refine}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => run("removeFormat")}
						className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 md:h-7 md:w-7"
					>
						<RemoveFormatting className="h-4 w-4" />
					</button>
				</Tooltip>
				{refineUndo && <Tooltip label={t("refine.undo")}><button type="button" aria-label={t("refine.undo")} disabled={disabled || !!refine} onMouseDown={event => event.preventDefault()} onClick={undoRefine} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 md:h-7 md:w-7"><Undo2 className="h-4 w-4" /></button></Tooltip>}
				</div>
				{toolbarEnd}
				{linkOpen && (
					<div
						className="absolute bottom-full inset-x-2 z-10 mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg md:right-auto"
					>
						<input
							autoFocus
							value={linkUrl}
							onChange={(event) => setLinkUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setLinkOpen(false);
								if (event.key === "Enter") { event.preventDefault(); applyLink(); }
							}}
							placeholder="https://example.com"
							className="h-11 min-w-0 flex-1 rounded-md border border-neutral-200 px-2 text-base outline-none focus:border-blue-400 md:h-8 md:w-64 md:text-sm"
						/>
						<button type="button" onClick={applyLink} className="min-h-11 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 md:min-h-8">
							{t("editor.apply")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
