"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/language-provider";
import { getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import { addressChipClassName } from "./address-field-styles";
import { RecipientInput } from "./recipient-input";
import type { RecipientFieldsProps } from "./recipient-input-types";
import { recipientAddressSet } from "./recipient-suggest-utils";
import { getRecipientLabel, moveRecipient, RECIPIENT_FIELDS } from "./recipient-utils";
import type { RecipientField } from "./recipient-utils";

/** How long a finger rests on a chip before it lifts off; a quicker move scrolls the lines instead. */
const TOUCH_HOLD_MS = 300;
/** Movement that turns a mouse press into a drag, and that cancels a touch hold. */
const MOUSE_DRAG_PX = 5;
const TOUCH_SLOP_PX = 8;

type Press = {
	pointerId: number;
	startX: number;
	startY: number;
	x: number;
	y: number;
	field: RecipientField;
	entry: string;
	touch: boolean;
	active: boolean;
	timer: ReturnType<typeof setTimeout> | null;
};
type DropTarget = { field: RecipientField; index: number };
type Drag = { entry: string; from: RecipientField; touch: boolean; x: number; y: number; target: DropTarget | null };

function isRecipientField(value: string | undefined): value is RecipientField {
	return RECIPIENT_FIELDS.includes(value as RecipientField);
}

/** The line under the pointer and the place among its chips, in reading order. */
function findDropTarget(root: HTMLElement, x: number, y: number): DropTarget | null {
	const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-recipient-field]");
	if (!row || !root.contains(row) || !isRecipientField(row.dataset.recipientField)) return null;
	const rtl = getComputedStyle(row).direction === "rtl";
	const chips = Array.from(row.querySelectorAll<HTMLElement>("[data-recipient-chip]"));
	let index = chips.length;
	for (let position = 0; position < chips.length; position++) {
		const rect = chips[position].getBoundingClientRect();
		const middle = rect.left + rect.width / 2;
		const before = y < rect.top || (y <= rect.bottom && (rtl ? x > middle : x < middle));
		if (before) { index = position; break; }
	}
	return { field: row.dataset.recipientField, index };
}

/**
 * The To, Cc and Bcc lines of a message. A recipient moves between them by
 * dragging its chip (press and hold on a touch screen) or from the chip's menu.
 * While a chip is dragged, the lines that are still folded away open so it can
 * be dropped on them.
 */
export function RecipientFields({ idPrefix, to, cc, bcc, onChange, showCc, showBcc, onShowCc, onShowBcc, disabled, directory, toPlaceholder, error }: RecipientFieldsProps) {
	const { t } = useLanguage();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const press = useRef<Press | null>(null);
	const release = useRef<(() => void) | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [focusOnReveal, setFocusOnReveal] = useState<RecipientField | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const fields = useMemo(() => ({ to, cc, bcc }), [to, cc, bcc]);
	const chosen = useMemo(() => recipientAddressSet(to, cc, bcc), [to, cc, bcc]);
	const labels: Record<RecipientField, string> = { to: t("compose.to"), cc: t("compose.cc"), bcc: t("compose.bcc") };
	// Read through a ref by the window listeners, which outlive the render that added them.
	const latest = useRef({ fields, onChange, showCc, showBcc, onShowCc, onShowBcc, labels, t });
	useEffect(() => { latest.current = { fields, onChange, showCc, showBcc, onShowCc, onShowBcc, labels, t }; });
	useEffect(() => () => release.current?.(), []);

	function move(entry: string, from: RecipientField, target: RecipientField, index?: number) {
		const current = latest.current;
		const next = moveRecipient(current.fields, entry, from, target, index);
		if (next === current.fields) return;
		current.onChange(next);
		if (target === "cc" && !current.showCc) current.onShowCc();
		if (target === "bcc" && !current.showBcc) current.onShowBcc();
		if (from !== target) setAnnouncement(current.t("recipient.moved", { address: getEmailAddress(entry), field: current.labels[target] }));
	}

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		if (disabled || press.current || !event.isPrimary || event.button !== 0) return;
		const origin = event.target as Element;
		if (origin.closest("[data-recipient-remove]")) return;
		const chip = origin.closest<HTMLElement>("[data-recipient-chip]");
		const field = chip?.dataset.field;
		const entry = chip?.dataset.entry;
		if (!chip || !entry || !isRecipientField(field)) return;

		const current: Press = {
			pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
			field, entry, touch: event.pointerType !== "mouse", active: false, timer: null,
		};
		press.current = current;

		const activate = () => {
			if (press.current !== current || current.active) return;
			current.active = true;
			if (current.touch) { try { navigator.vibrate?.(8); } catch { /* Haptics are optional. */ } }
			setAnnouncement(latest.current.t("recipient.dragging", { address: getEmailAddress(current.entry) }));
			update();
		};
		const update = () => {
			const root = rootRef.current;
			setDrag({ entry: current.entry, from: current.field, touch: current.touch, x: current.x, y: current.y, target: root ? findDropTarget(root, current.x, current.y) : null });
		};
		const finish = () => {
			if (current.timer) clearTimeout(current.timer);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onCancel, true);
			window.removeEventListener("touchmove", onTouchMove, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("contextmenu", onContextMenu, true);
			window.removeEventListener("blur", finish);
			if (press.current === current) press.current = null;
			release.current = null;
			setDrag(null);
		};
		const onMove = (moved: PointerEvent) => {
			if (moved.pointerId !== current.pointerId) return;
			current.x = moved.clientX;
			current.y = moved.clientY;
			if (!current.active) {
				const distance = Math.hypot(current.x - current.startX, current.y - current.startY);
				if (distance <= (current.touch ? TOUCH_SLOP_PX : MOUSE_DRAG_PX)) return;
				// A finger that moves before the chip lifts off is scrolling the lines.
				if (current.touch) { finish(); return; }
				activate();
				return;
			}
			update();
		};
		const onUp = (released: PointerEvent) => {
			if (released.pointerId !== current.pointerId) return;
			const wasActive = current.active;
			const root = rootRef.current;
			const target = wasActive && root ? findDropTarget(root, released.clientX, released.clientY) : null;
			finish();
			if (!wasActive) return;
			// The release also ends a click on whatever lies under the pointer; it must not open a chip's menu.
			const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
			window.addEventListener("click", swallow, true);
			setTimeout(() => window.removeEventListener("click", swallow, true), 60);
			if (target) move(current.entry, current.field, target.field, target.index);
			else setAnnouncement("");
		};
		const onCancel = (cancelled: PointerEvent) => { if (cancelled.pointerId === current.pointerId) finish(); };
		// Once the chip is lifted, the finger moves the chip, not the page.
		const onTouchMove = (moved: TouchEvent) => { if (current.active && moved.cancelable) moved.preventDefault(); };
		const onKey = (key: KeyboardEvent) => {
			if (key.key !== "Escape" || !current.active) return;
			key.preventDefault();
			key.stopPropagation();
			finish();
		};
		// A long press must lift the chip, not open the browser's own menu.
		const onContextMenu = (menu: MouseEvent) => { if (current.touch) menu.preventDefault(); };

		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onCancel, true);
		window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("contextmenu", onContextMenu, true);
		window.addEventListener("blur", finish);
		release.current = finish;
		if (current.touch) current.timer = setTimeout(activate, TOUCH_HOLD_MS);
	}

	// Pressing a toggle must not blur the line being typed in first: the blur folds that line's
	// empty input away, the row gets shorter, and the toggle slides out from under the pointer.
	const keepFocus = (event: React.MouseEvent) => event.preventDefault();
	const dragging = drag !== null;
	const row = (field: RecipientField, extra: { placeholder: string; required?: boolean; trailing?: React.ReactNode }) => (
		<RecipientInput
			id={`${idPrefix}-${field}`}
			field={field}
			label={labels[field]}
			value={fields[field]}
			onChange={(next) => onChange({ ...fields, [field]: next })}
			placeholder={dragging && field !== "to" && fields[field].length === 0 ? t("recipient.dropHere") : extra.placeholder}
			required={extra.required}
			disabled={disabled}
			autoFocus={!disabled && focusOnReveal === field && fields[field].length === 0}
			trailing={extra.trailing}
			directory={directory}
			chosen={chosen}
			moveTargets={RECIPIENT_FIELDS.filter((other) => other !== field).map((other) => ({ field: other, label: labels[other] }))}
			onMove={(entry, target) => move(entry, field, target)}
			dropIndex={drag?.target?.field === field ? drag.target.index : null}
			draggingEntry={drag?.from === field ? drag.entry : null}
			errorId={error?.field === field ? `${idPrefix}-${field}-error` : undefined}
		/>
	);
	const errorLine = (field: RecipientField) => error?.field === field && (
		<p id={`${idPrefix}-${field}-error`} role="alert" className="border-b border-neutral-100 px-4 py-1.5 text-sm text-red-700">{error.message}</p>
	);

	return (
		<div ref={rootRef} data-recipient-fields onPointerDown={onPointerDown} className={cn(dragging && "cursor-grabbing")}>
			{row("to", {
				placeholder: toPlaceholder ?? t("compose.toPlaceholder"),
				required: true,
				trailing: !showCc || !showBcc ? (
					<>
						{!showCc && (
							<button type="button" className="min-h-9 min-w-9 rounded px-1 hover:text-neutral-800 md:min-h-7" onMouseDown={keepFocus} onClick={() => { setFocusOnReveal("cc"); onShowCc(); }}>
								{t("compose.cc")}
							</button>
						)}
						{!showBcc && (
							<button type="button" className="min-h-9 min-w-9 rounded px-1 hover:text-neutral-800 md:min-h-7" onMouseDown={keepFocus} onClick={() => { setFocusOnReveal("bcc"); onShowBcc(); }}>
								{t("compose.bcc")}
							</button>
						)}
					</>
				) : undefined,
			})}
			{errorLine("to")}
			{(showCc || dragging) && row("cc", { placeholder: t("compose.ccPlaceholder") })}
			{errorLine("cc")}
			{(showBcc || dragging) && row("bcc", { placeholder: t("compose.bccPlaceholder") })}
			{errorLine("bcc")}
			<span role="status" aria-live="polite" className="sr-only">{announcement}</span>
			{drag && createPortal(
				<div
					aria-hidden="true"
					data-compose-layer
					data-recipient-drag-ghost
					className={cn(addressChipClassName, "pointer-events-none fixed left-0 top-0 z-[200] max-w-[min(280px,80vw)] border-blue-400 bg-white text-neutral-900 shadow-lg")}
					// Above the finger on touch screens, beside the arrow with a mouse.
					style={{ transform: drag.touch ? `translate(${drag.x}px, ${drag.y}px) translate(-50%, -150%)` : `translate(${drag.x + 12}px, ${drag.y + 14}px)` }}
				>
					<span className="truncate">{getRecipientLabel(drag.entry)}</span>
				</div>,
				document.body,
			)}
		</div>
	);
}
