"use client";

import { useRef } from "react";

// Where focus should return to, resolved when focus arrives (a menu item is resolved to its menu's
// trigger while the menu still exists), so a dialog opened after focus already fell to <body> — a menu
// that unmounted, a control that blurred itself — can still return the visitor there.
// A short history rather than one element: when one dialog hands over to another (the command
// palette opening the shortcut help), the newest entry has gone and the one before it is the answer.
const history: HTMLElement[] = [];
let tracking = false;
function trackFocus() {
	if (tracking || typeof document === "undefined") return;
	tracking = true;
	document.addEventListener("focusin", (event) => {
		const target = event.target instanceof HTMLElement ? returnTarget(event.target) : null;
		if (!target || history.at(-1) === target) return;
		history.push(target);
		if (history.length > 10) history.shift();
	}, true);
}
const lastConnected = () => [...history].reverse().find((element) => element.isConnected) ?? null;

/** A menu item disappears with its menu; the menu's trigger is where focus belongs afterwards. */
function returnTarget(element: HTMLElement | null): HTMLElement | null {
	if (!element || element === document.body) return null;
	const menu = element.closest<HTMLElement>('[role="menu"]');
	if (!menu) return element;
	const triggerId = menu.getAttribute("aria-labelledby");
	return (triggerId && document.getElementById(triggerId)) || null;
}

/**
 * Radix returns focus to a Dialog.Trigger on close. Dialogs opened another way (a menu item, a shortcut,
 * a promise) would otherwise leave focus on <body>. These handlers remember where the visitor was when the
 * dialog opened and put focus back on close, unless that element has gone in the meantime.
 */
export function useReturnFocus() {
	trackFocus();
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus() {
			const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			opener.current = returnTarget(active) ?? lastConnected();
		},
		onCloseAutoFocus(event: Event) {
			const target = opener.current;
			opener.current = null;
			if (!target?.isConnected) return;
			event.preventDefault();
			target.focus({ preventScroll: true });
		},
	};
}
