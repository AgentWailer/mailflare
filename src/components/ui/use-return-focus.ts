"use client";

import { useRef } from "react";

/**
 * Radix returns focus to a Dialog.Trigger on close. Dialogs opened another way (a menu item, a shortcut,
 * a promise) would otherwise leave focus on <body>. These handlers remember what had focus when the dialog
 * opened and put it back on close, unless that element has gone in the meantime.
 */
export function useReturnFocus() {
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus() {
			const active = document.activeElement;
			opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
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
