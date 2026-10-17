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
import { captureRefineTarget, applyRefinement } from "./refine-utils";
import { readRefinePreferences, saveRefinePreferences } from "./refine-preferences";
import { ComposeAiBar } from "./compose-ai-bar";
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
	toolbarAttachment,
	footerContent,
	onRefineActiveChange,
}: RichTextEditorProps) {
	const { t } = useLanguage();
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [formattingOpen, setFormattingOpen] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [preferences, setPreferences] = useState(readRefinePreferences);
	const promptRef = useRef<HTMLInputElement>(null);
	const pendingSelection = useRef<RefineTarget | null>(null);
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const [refine, setRefine] = useState<{ mailboxId: string; snapshot: string; draftReply: boolean; replyContext?: RefineReplyContext; contextKey: string; instruction: string; selection: RefineTarget | null; message: RefineTarget | null } | null>(null);
	const [refineUndo, setRefineUndo] = useState<Array<{ mailboxId: string; before: string; after: string }>>([]);
	const savedRange = useRef<Range | null>(null);

	const [undoMailbox, setUndoMailbox] = useState(mailboxId);
	if (undoMailbox !== mailboxId) { setUndoMailbox(mailboxId); setRefineUndo([]); setInstruction(""); }
	useEffect(() => { pendingSelection.current = null; }, [mailboxId]);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (!element) return;
		const safeValue = sanitizeEditorHtml(value);
		if (element.innerHTML !== safeValue) element.innerHTML = safeValue;
		if (refine && (mailboxId !== refine.mailboxId || element.innerHTML !== refine.snapshot || refine.draftReply && JSON.stringify(replyContext) !== refine.contextKey)) { setRefine(null); }
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

	function openRefine(instructionText = "", polishOnly = false) {
		const element = editorRef.current;
		if (!element || !mailboxId) return;
		setLinkOpen(false);
		const selection = (pendingSelection.current?.snapshot === element.innerHTML ? pendingSelection.current : null) ?? captureRefineTarget(element, "selection", window.getSelection());
		const message = captureRefineTarget(element, "message", null);
		if (polishOnly && !selection && !message) { promptRef.current?.focus(); return; }
		const hasHistory = !!(replyContext?.threadId || replyContext?.inReplyTo || replyContext?.quotedText?.trim());
		if (!selection && !message && !hasHistory && !instructionText.trim()) { promptRef.current?.focus(); return; }
		const selectedPreferences = polishOnly ? { ...preferences, mode: "polish" as const } : preferences;
		if (polishOnly) setPreferences(selectedPreferences);
		saveRefinePreferences(selectedPreferences);
		setRefine({ instruction: instructionText.trim(), mailboxId, snapshot: element.innerHTML, draftReply: !selection && !message, replyContext, contextKey: JSON.stringify(replyContext), selection, message: message ?? captureRefineTarget(element, "message", null, true) });
		pendingSelection.current = null;
		element.blur();
	}

	function closeRefine() { setRefine(null); }

	function applyRefine(target: RefineTarget, text: string) {
		const element = editorRef.current;
		if (!element || !refine || !mailboxId || disabled || mailboxId !== refine.mailboxId || !applyRefinement(element, target, text)) return false;
		const entry = { mailboxId: refine.mailboxId, before: target.snapshot, after: element.innerHTML };
		setRefineUndo(previous => [...(previous.at(-1)?.after === entry.before && previous.at(-1)?.mailboxId === mailboxId ? previous : []), entry].slice(-10));
		setInstruction("");
		emit();
		return true;
	}

	const latestUndo = refineUndo.at(-1);
 function undoRefine() {
  const element = editorRef.current;
  if (!element || !latestUndo || disabled || mailboxId !== latestUndo.mailboxId || element.innerHTML !== latestUndo.after) { setRefineUndo([]); return; }
  element.innerHTML = latestUndo.before;
  setRefineUndo(previous => previous.slice(0, -1));
  emit(); element.focus({ preventScroll: true });
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
		setFormattingOpen(false);
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
		if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z" && latestUndo && editorRef.current?.innerHTML === latestUndo.after && mailboxId === latestUndo.mailboxId) { event.preventDefault(); undoRefine(); return; }
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openLink();
		}
	}

	return (
		<div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
				<div
					ref={editorRef}
					id={id}
					role="textbox"
					aria-multiline="true"
					aria-label={t("editor.messageBody")}
					contentEditable={!disabled && !refine}
					aria-readonly={!!refine || disabled}
					suppressContentEditableWarning
					data-placeholder={placeholder}
					onInput={() => { pendingSelection.current = null; setRefineUndo([]); emit(); }}
					onBlur={emit}
					onPaste={onPaste}
					onKeyDown={event => { if (event.key === "Escape" && refine) { event.preventDefault(); closeRefine(); } else onKeyDown(event); }}
					className={cn(
						"email-body flex-1 max-w-none break-words px-4 py-3 text-base text-neutral-900 outline-none md:text-sm",
						"min-h-32 empty:before:pointer-events-none empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]",
						disabled && "cursor-not-allowed opacity-60",
					)}
				/>
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
   {footerContent}
   {latestUndo && mailboxId === latestUndo.mailboxId && <div data-compose-ai-undo className="mx-4 mb-2 flex shrink-0 items-center gap-2 text-xs text-neutral-600"><span role="status" className="min-w-0 flex-1">{t("refine.updated")}</span><button type="button" disabled={disabled || !!refine} onClick={undoRefine} aria-label={t("refine.undo")} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 font-medium text-blue-700 hover:bg-blue-50 md:min-h-8"><Undo2 aria-hidden="true" className="h-4 w-4"/>{t("refine.undoShort")}</button></div>}
   {mailboxId && !refine && <ComposeAiBar inputRef={promptRef} instruction={instruction} onInstructionChange={setInstruction} preferences={preferences} onPreferencesChange={setPreferences} disabled={disabled} onSubmit={() => openRefine(instruction)} onPolish={() => openRefine("", true)} onCaptureSelection={() => { const element = editorRef.current; pendingSelection.current = element ? captureRefineTarget(element, "selection", window.getSelection()) : null; }} />}

   {refine && <RefineControls draftReply={refine.draftReply} replyContext={refine.replyContext} instruction={refine.instruction} preferences={preferences} mailboxId={refine.mailboxId} selection={refine.selection} message={refine.message} onApply={applyRefine} onClose={closeRefine}/>}
   {formattingOpen && <div data-compose-formatting className="absolute inset-x-4 bottom-16 z-20 mb-2 flex flex-wrap items-center gap-0.5 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">

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
    <button type="button" onMouseDown={e=>e.preventDefault()} disabled={disabled || !!refine} onClick={openLink} aria-label={t("editor.insertLink")} className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 md:hidden"><Link2 className="h-4 w-4"/></button>
   </div>}
   <div className="compose-toolbar relative flex shrink-0 items-center gap-0.5 bg-white px-3 pb-3 pt-1 md:px-4">
    {toolbarStart}
    <Tooltip label={t("editor.formatting")}><button type="button" aria-label={t("editor.formatting")} aria-expanded={formattingOpen} disabled={disabled || !!refine} onMouseDown={event=>event.preventDefault()} onClick={()=>setFormattingOpen(open=>!open)} className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 md:h-9 md:w-9",formattingOpen&&"bg-neutral-100 text-neutral-900")}><Type aria-hidden="true" className="h-5 w-5"/></button></Tooltip>
    {mailboxId && <Tooltip label={t("refine.title")}><button type="button" aria-label={t("refine.title")} disabled={disabled || !!refine} onPointerDown={()=>{const e=editorRef.current;pendingSelection.current=e?captureRefineTarget(e,"selection",window.getSelection()):null;}} onMouseDown={event=>event.preventDefault()} onClick={()=>openRefine()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-blue-700 hover:bg-blue-50 disabled:opacity-50 md:h-9 md:w-9"><Sparkles aria-hidden="true" className="h-5 w-5"/></button></Tooltip>}

    {toolbarAttachment}
				<Tooltip label={t("editor.insertLinkHint")}>
					<button
						type="button"
						aria-label={t("editor.insertLink")}
						disabled={disabled || !!refine}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLink}
						className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 md:flex"
					>
						<Link2 className="h-4 w-4" />
					</button>
				</Tooltip>
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
