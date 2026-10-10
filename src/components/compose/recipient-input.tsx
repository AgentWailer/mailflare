"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Label } from "@/components/ui/label";
import { getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import { addressChipClassName, addressLabelClassName, addressRowClassName } from "./address-field-styles";
import type { RecipientInputProps } from "./recipient-input-types";
import { getRecipientLabel, isValidRecipient, parseRecipientEntries } from "./recipient-utils";

/**
 * A To/Cc/Bcc row. Addresses become chips as soon as the user types a comma,
 * presses Enter or Tab, pastes a list, or leaves the field; Backspace on an
 * empty field pulls the last chip back out for editing.
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
}: RecipientInputProps) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState("");
	const [focused, setFocused] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const editing = focused || draft.length > 0 || value.length === 0;

	function commit(raw = draft) {
		const entries = parseRecipientEntries(raw, value);
		if (entries.length > 0) onChange([...value, ...entries]);
		setDraft("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "," || event.key === ";" || event.key === "Enter" || (event.key === "Tab" && draft.trim())) {
			if (event.key !== "Tab") event.preventDefault();
			commit();
			return;
		}
		if (event.key === "Backspace" && !draft && value.length > 0) {
			event.preventDefault();
			const last = value[value.length - 1];
			onChange(value.slice(0, -1));
			setDraft(last);
		}
	}

	return (
		<div
			className={addressRowClassName}
			onClick={() => inputRef.current?.focus()}
		>
			<Label htmlFor={id} className={addressLabelClassName}>
				{label}
			</Label>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
				{value.map((entry) => {
					const valid = isValidRecipient(entry);
					return (
						<span
							key={entry}
							title={getEmailAddress(entry)}
							className={cn(
								addressChipClassName,
								editing ? "max-w-full" : "max-w-[calc(100%-0.75rem)]",
								valid
									? "border-neutral-200 bg-neutral-50 text-neutral-800"
									: "border-red-200 bg-red-50 text-red-700",
							)}
						>
							<span className="truncate">{getRecipientLabel(entry)}</span>
							{!disabled && (
								<button
									type="button"
									aria-label={t("recipient.remove", { address: getEmailAddress(entry) })}
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
					);
				})}
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
						setDraft(event.target.value);
					}}
					onKeyDown={onKeyDown}
					onFocus={() => setFocused(true)}
					onBlur={() => { commit(); setFocused(false); }}
					type="text"
					autoComplete="off"
					autoFocus={autoFocus}
					spellCheck={false}
					placeholder={value.length === 0 ? placeholder : undefined}
					disabled={disabled}
					// Native `required` would block submit while chips exist; the form checks itself.
					aria-required={required}
					className={cn(
						"h-8 flex-1 border-0 bg-transparent p-0 text-base outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed md:h-7 md:text-sm",
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
		</div>
	);
}
