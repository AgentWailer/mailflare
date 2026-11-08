"use client";

import { useSyncExternalStore } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { useReturnFocus } from "@/components/ui/use-return-focus";
import type { ConfirmOptions } from "./confirm-dialog-types";

type Request = ConfirmOptions & { resolve: (confirmed: boolean) => void };

let current: Request | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * An in-app replacement for window.confirm: a branded dialog whose confirm button names the action.
 * Resolves false when dismissed. A newer request supersedes (and declines) an unanswered one.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		current?.resolve(false);
		current = { ...options, resolve };
		publish();
	});
}

function settle(confirmed: boolean) {
	const request = current;
	current = null;
	publish();
	request?.resolve(confirmed);
}

/** Mounted once in the app providers. */
export function ConfirmDialogHost() {
	const { t } = useLanguage();
	const request = useSyncExternalStore(subscribe, () => current, () => null);
	const returnFocus = useReturnFocus();
	return (
		<DialogPrimitive.Root open={request !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-[160] bg-black/35" />
				<DialogPrimitive.Content role="alertdialog" aria-describedby={request?.description ? "confirm-dialog-description" : undefined} onOpenAutoFocus={returnFocus.onOpenAutoFocus} onCloseAutoFocus={returnFocus.onCloseAutoFocus}
					className="dialog-content fixed left-1/2 top-1/2 z-[170] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-xl outline-none sm:p-6">
					<DialogPrimitive.Title className="text-base font-semibold leading-6 text-neutral-900">{request?.title}</DialogPrimitive.Title>
					{request?.description && <DialogPrimitive.Description id="confirm-dialog-description" className="mt-2 text-sm leading-6 text-neutral-600">{request.description}</DialogPrimitive.Description>}
					<div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<DialogPrimitive.Close asChild><Button type="button" variant="outline">{request?.cancelLabel ?? t("common.cancel")}</Button></DialogPrimitive.Close>
						<Button type="button" variant={request?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{request?.confirmLabel}</Button>
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
