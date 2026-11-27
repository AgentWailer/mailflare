"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, Copy, Pencil, Trash2, X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Label } from "@/components/ui/label";
import { getEmailAddress } from "@/lib/email/address";
import type { RecipientCandidate } from "@/lib/contacts/recipient-directory-types";
import { cn } from "@/lib/utils";
import { addressChipClassName, addressLabelClassName, addressRowClassName } from "./address-field-styles";
import type { RecipientInputProps } from "./recipient-input-types";
import { candidateToRecipient, suggestRecipients } from "./recipient-suggest-utils";
import { getRecipientLabel, isValidRecipient, parseRecipientEntries } from "./recipient-utils";

const NO_DIRECTORY: readonly RecipientCandidate[] = [];
const NOTHING_CHOSEN: ReadonlySet<string> = new Set();
// Finger-sized on touch screens through the [data-recipient-menu] rule in globals.css.
const menuItemClassName = "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100";

/** Where the suggestion list goes: under the line, inside what the on-screen keyboard leaves visible. */
function useSuggestionPosition(anchor: React.RefObject<HTMLElement | null>, open: boolean): CSSProperties | null {
	const [style, setStyle] = useState<CSSProperties | null>(null);
	useLayoutEffect(() => {
		const element = anchor.current;
		if (!open || !element) return;
		const place = () => {
			const rect = element.getBoundingClientRect();
			const viewport = window.visualViewport;
			const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
			const pageWidth = document.documentElement.clientWidth;
			const width = Math.min(Math.max(rect.width, 260), 440, pageWidth - 16);
			const left = Math.max(8, Math.min(rect.left, pageWidth - width - 8));
			setStyle({ position: "fixed", top: rect.bottom + 6, left, width, maxHeight: Math.max(96, Math.min(320, visibleBottom - rect.bottom - 14)) });
		};
		place();
		const viewport = window.visualViewport;
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		viewport?.addEventListener("resize", place);
		viewport?.addEventListener("scroll", place);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
			viewport?.removeEventListener("resize", place);
			viewport?.removeEventListener("scroll", place);
		};
	}, [anchor, open]);
	return open ? style : null;
}

/**
 * A To/Cc/Bcc row. Addresses become chips as soon as the user types a comma,
 * presses Enter or Tab, pastes a list, or leaves the field; Backspace on an
 * empty field pulls the last chip back out for editing. While typing, people
 * the owner writes to are suggested. A chip opens a menu to move it to another
 * line, edit, copy or remove it; RecipientFields adds dragging between lines.
 */
export function RecipientInput({
	id,
	label,
	value,
	onChange,
	placeholder,
	disabled,
	required,
	autoFocus,
	trailing,
	errorId,
	field,
	directory = NO_DIRECTORY,
	chosen = NOTHING_CHOSEN,
	moveTargets,
	onMove,
	dropIndex = null,
	draggingEntry = null,
}: RecipientInputProps) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState("");
	const [focused, setFocused] = useState(false);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [active, setActive] = useState<number | null>(null);
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const menuWasOpen = useRef(false);
	const listId = useId();
	const editing = focused || draft.length > 0 || value.length === 0;

	const suggestions = useMemo(
		() => (focused && !disabled && dismissedFor !== draft ? suggestRecipients(directory, draft, chosen, 6) : []),
		[chosen, directory, disabled, dismissedFor, draft, focused],
	);
	const open = suggestions.length > 0;
	// A complete address is what the writer means; a suggestion replaces it only when chosen.
	const highlighted = active !== null && active < suggestions.length ? active : open && !isValidRecipient(draft.trim()) ? 0 : null;
	const position = useSuggestionPosition(anchorRef, open);

	useEffect(() => {
		if (highlighted === null) return;
		document.getElementById(`${listId}-${highlighted}`)?.scrollIntoView({ block: "nearest" });
	}, [highlighted, listId]);

	function changeDraft(next: string) {
		setDraft(next);
		setActive(null);
		setDismissedFor(null);
	}

	function commit(raw = draft) {
		const entries = parseRecipientEntries(raw, value);
		if (entries.length > 0) onChange([...value, ...entries]);
		changeDraft("");
	}

	function pick(candidate: RecipientCandidate) {
		onChange([...value, candidateToRecipient(candidate)]);
		changeDraft("");
		inputRef.current?.focus();
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive(highlighted === null ? (step === 1 ? 0 : suggestions.length - 1) : (highlighted + step + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Escape") {
				// Close only the list; the composer's own Escape handling must not also run.
				event.preventDefault();
				event.stopPropagation();
				setDismissedFor(draft);
				return;
			}
			// Shift+Tab goes back to the previous control; it never picks.
			if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) && highlighted !== null) {
				event.preventDefault();
				pick(suggestions[highlighted]);
				return;
			}
		}
		if (event.key === "," || event.key === ";" || event.key === "Enter" || (event.key === "Tab" && draft.trim())) {
			if (event.key !== "Tab") event.preventDefault();
			commit();
			return;
		}
		if (event.key === "Backspace" && !draft && value.length > 0) {
			event.preventDefault();
			const last = value[value.length - 1];
			onChange(value.slice(0, -1));
			changeDraft(last);
		}
	}

	function edit(entry: string) {
		const rest = value.filter((item) => item !== entry);
		const pending = parseRecipientEntries(draft, rest);
		onChange([...rest, ...pending]);
		changeDraft(entry);
		// The menu returns focus to its chip, which is gone by then.
		setTimeout(() => inputRef.current?.focus(), 0);
	}

	return (
		<div
			className={cn(addressRowClassName, dropIndex !== null && "bg-blue-50")}
			data-recipient-field={field}
			onClick={() => inputRef.current?.focus()}
		>
			<Label htmlFor={id} className={addressLabelClassName}>
				{label}
			</Label>
			<div ref={anchorRef} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
				{value.map((entry, index) => {
					const valid = isValidRecipient(entry);
					const address = getEmailAddress(entry);
					return (
						<span key={entry} className="contents">
							{dropIndex === index && <DropMarker />}
							<span
								title={address}
								data-recipient-chip
								data-field={field}
								data-entry={entry}
								className={cn(
									addressChipClassName,
									"select-none [-webkit-touch-callout:none]",
									editing ? "max-w-full" : "max-w-[calc(100%-0.75rem)]",
									valid
										? "border-neutral-200 bg-neutral-50 text-neutral-800"
										: "border-red-200 bg-red-50 text-red-700",
									draggingEntry === entry && "opacity-40",
								)}
							>
								<DropdownMenu.Root open={menuFor === entry} onOpenChange={(next) => setMenuFor(next ? entry : null)}>
									<DropdownMenu.Trigger asChild disabled={disabled}>
										<button
											type="button"
											className="min-w-0 cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default"
											// Open on click, not on press: a press may be the start of dragging the chip.
											onPointerDown={(event) => { menuWasOpen.current = menuFor === entry; event.preventDefault(); }}
											onClick={(event) => {
												event.stopPropagation();
												if (!menuWasOpen.current) setMenuFor(entry);
												menuWasOpen.current = false;
											}}
										>
											{getRecipientLabel(entry)}
										</button>
									</DropdownMenu.Trigger>
									<DropdownMenu.Portal>
										<DropdownMenu.Content
											data-compose-layer
											data-recipient-menu
											align="start"
											sideOffset={6}
											collisionPadding={8}
											onClick={(event) => event.stopPropagation()}
											className="z-[170] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-52 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 text-sm text-neutral-800 shadow-lg"
										>
											<DropdownMenu.Label className="truncate px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">{address}</DropdownMenu.Label>
											{onMove && moveTargets?.map((target) => (
												<DropdownMenu.Item key={target.field} className={menuItemClassName} onSelect={() => onMove(entry, target.field)}>
													<ArrowRightLeft className="h-4 w-4 shrink-0 text-neutral-500" />
													{t("recipient.moveTo", { field: target.label })}
												</DropdownMenu.Item>
											))}
											{onMove && !!moveTargets?.length && <DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />}
											<DropdownMenu.Item className={menuItemClassName} onSelect={() => edit(entry)}>
												<Pencil className="h-4 w-4 shrink-0 text-neutral-500" />
												{t("recipient.edit")}
											</DropdownMenu.Item>
											<DropdownMenu.Item className={menuItemClassName} onSelect={() => { void navigator.clipboard?.writeText(address).catch(() => {}); }}>
												<Copy className="h-4 w-4 shrink-0 text-neutral-500" />
												{t("recipient.copy")}
											</DropdownMenu.Item>
											<DropdownMenu.Item className={cn(menuItemClassName, "text-red-700")} onSelect={() => onChange(value.filter((item) => item !== entry))}>
												<Trash2 className="h-4 w-4 shrink-0" />
												{t("recipient.removeItem")}
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Portal>
								</DropdownMenu.Root>
								{!disabled && (
									<button
										type="button"
										data-recipient-remove
										aria-label={t("recipient.remove", { address })}
										className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
										onClick={(event) => {
											event.stopPropagation();
											onChange(value.filter((item) => item !== entry));
										}}
									>
										<X className="h-3.5 w-3.5" />
									</button>
								)}
							</span>
						</span>
					);
				})}
				{dropIndex !== null && dropIndex >= value.length && <DropMarker />}
				<input
					ref={inputRef}
					id={id}
					value={draft}
					onChange={(event) => {
						// A pasted list should split immediately instead of waiting for a comma.
						if (/[,;]/.test(event.target.value) && event.target.value.length - draft.length > 1) {
							commit(event.target.value);
							return;
						}
						changeDraft(event.target.value);
					}}
					onKeyDown={onKeyDown}
					onFocus={() => setFocused(true)}
					onBlur={() => { commit(); setFocused(false); }}
					type="text"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={open}
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open && highlighted !== null ? `${listId}-${highlighted}` : undefined}
					autoComplete="off"
					autoCapitalize="none"
					autoCorrect="off"
					autoFocus={autoFocus}
					spellCheck={false}
					placeholder={value.length === 0 ? placeholder : undefined}
					disabled={disabled}
					// Native `required` would block submit while chips exist; the form checks itself.
					aria-required={required}
					aria-invalid={errorId ? true : undefined}
					aria-describedby={errorId}
					className={cn(
						"h-8 flex-1 border-0 bg-transparent p-0 text-base outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed md:h-7 md:text-sm",
						// Leave a small focusable area after the chips, without forcing an empty second line.
						editing ? "min-w-[min(128px,100%)]" : "min-w-0 basis-0",
					)}
				/>
			</div>
			{trailing && (
				// Toggles live inside the clickable row; keep their clicks from refocusing this field.
				<div
					className="flex shrink-0 items-center gap-1 text-base font-normal text-neutral-500 md:text-sm"
					onClick={(event) => event.stopPropagation()}
				>
					{trailing}
				</div>
			)}
			{open && position && createPortal(
				<ul
					id={listId}
					role="listbox"
					aria-label={t("recipient.suggestions")}
					data-compose-layer
					data-recipient-suggestions
					style={position}
					className="z-[170] overflow-y-auto overscroll-contain rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg"
					// Keep the caret in the field: choosing a suggestion must not blur and commit the half-typed text.
					onPointerDown={(event) => event.preventDefault()}
					onMouseDown={(event) => event.preventDefault()}
				>
					{suggestions.map((candidate, index) => (
						<li
							key={candidate.email}
							id={`${listId}-${index}`}
							role="option"
							aria-selected={highlighted === index}
							className={cn("flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-3 py-1.5", highlighted === index ? "bg-blue-50" : "hover:bg-neutral-100")}
							onClick={() => pick(candidate)}
						>
							<span className="truncate font-medium text-neutral-900">{candidate.name || candidate.email}</span>
							{candidate.name && <span className={cn("truncate text-xs", highlighted === index ? "text-neutral-700" : "text-neutral-500")}>{candidate.email}</span>}
						</li>
					))}
				</ul>,
				document.body,
			)}
		</div>
	);
}

/** Marks where a dragged chip lands. Its margins cancel its width and the flex gap, so nothing shifts. */
function DropMarker() {
	return <span aria-hidden="true" data-recipient-drop-marker className="-mx-1 h-6 w-0.5 shrink-0 self-center rounded bg-blue-500" />;
}
