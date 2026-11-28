"use client";

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { announceStatus } from "@/lib/status-announcer";
import type { ComposePrefill } from "./mailto-utils";

// Only ever shown after a message was sent with an undo window: kept out of the startup bundle.
// If it cannot be loaded (connection lost right after sending), the page carries on without the
// offer; the message is still held and can be taken back under Scheduled.
const UndoSendToast = lazy(() => import("./undo-send-toast").then((module) => ({ default: module.UndoSendToast })).catch(() => ({ default: (() => null) as typeof import("./undo-send-toast").UndoSendToast })));

/** A message that was just sent with an undo window and has not been delivered yet. */
export type PendingUndoSend = { messageId: string; until: number; /** Whom it goes to and what it is about, to tell several waiting messages apart. */ recipient?: string; subject?: string };

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	/** What a new message starts with when it was opened from a link, and a number that changes with each such opening. */
	prefill: ComposePrefill | null;
	composeId: number;
	/** The open draft was created a moment ago as a reply: its recipients are the answered message's. */
	freshReply: boolean;
	openComposer: () => void;
	/**
	 * A new message that starts with these recipients, subject and text, e.g. from a mailto link.
	 * False when a composer holds a message being written: that one is not put aside for a link.
	 */
	openComposerWith: (prefill: ComposePrefill) => boolean;
	openDraftComposer: (draftId: string, options?: { freshReply?: boolean }) => void;
	closeComposer: () => void;
	/** Offer to take `messageId` back for the `remainingMs` the server still holds it; the offer outlives the composer that sent it. */
	offerUndoSend: (messageId: string, remainingMs: number, recipient?: string, subject?: string) => void;
	/** A composer says whether it holds anything worth keeping (text, recipients, files). */
	reportOccupied: (composer: string, occupied: boolean) => void;
	isOccupied: () => boolean;
	/**
	 * A composer says that its message is on its way to the server. Until that send has answered, no
	 * other message is opened: the same draft opened again could be sent a second time. A message
	 * asked for meanwhile opens afterwards, unless it is the draft (`sentDraftId`) that just went out.
	 */
	setSending: (sending: boolean, sentDraftId?: string | null) => void;
	/** The page composer, while it is shown, opens a message taken back with Undo instead of the floating one. */
	setRestoreTarget: (target: ((draftId: string) => void) | null) => void;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

/** The composer context where there is one; a composer rendered on its own sends without an undo window. */
export function useOptionalCompose() {
	return useContext(ComposeContext);
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	// Several messages can wait at once: each keeps its own offer until its own window ends.
	const [pendingUndos, setPendingUndos] = useState<PendingUndoSend[]>([]);
	const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
	const [composeId, setComposeId] = useState(0);
	const [freshReply, setFreshReply] = useState(false);
	const occupied = useRef(new Set<string>());
	// Counted, not a flag: a first send's draft may still be on its way out while the next message is sent.
	const sending = useRef(0);
	// The message asked for while a send was under way. It opens once that send has answered, unless
	// the sending window is still there with its message (a send that failed).
	const blockedOpen = useRef<{ draftId: string | null; open: () => void } | null>(null);
	const setSending = useCallback((value: boolean, sentDraftId?: string | null) => {
		sending.current = Math.max(0, sending.current + (value ? 1 : -1));
		// The draft that went out is never opened again, whichever send is the last to end.
		if (!value && sentDraftId && blockedOpen.current?.draftId === sentDraftId) blockedOpen.current = null;
		if (sending.current > 0) return;
		const blocked = blockedOpen.current;
		blockedOpen.current = null;
		if (blocked && (blocked.draftId === null || blocked.draftId !== sentDraftId) && occupied.current.size === 0) blocked.open();
	}, []);
	/** True, and says so, while a send is under way: opening another message has to wait for its answer. */
	const waitsForSend = useCallback(() => {
		if (sending.current > 0) announceStatus("compose.sendingBusy");
		return sending.current > 0;
	}, []);
	const restoreTarget = useRef<((draftId: string) => void) | null>(null);
	const setRestoreTarget = useCallback((target: ((draftId: string) => void) | null) => { restoreTarget.current = target; }, []);

	const openDraftComposer = useCallback((nextDraftId: string, options?: { freshReply?: boolean }) => {
		if (waitsForSend()) {
			blockedOpen.current = { draftId: nextDraftId, open: () => {
				setPrefill(null);
				setFreshReply(!!options?.freshReply);
				setDraftId(nextDraftId);
				setOpen(true);
			} };
			return;
		}
		setPrefill(null);
		setFreshReply(!!options?.freshReply);
		setDraftId(nextDraftId);
		setOpen(true);
	}, [waitsForSend]);
	const reportOccupied = useCallback((composer: string, value: boolean) => {
		if (value) occupied.current.add(composer); else occupied.current.delete(composer);
	}, []);
	const isOccupied = useCallback(() => occupied.current.size > 0, []);
	const endUndoOffer = useCallback((messageId: string) => setPendingUndos((current) => current.filter((entry) => entry.messageId !== messageId)), []);
	/** The restored message opens where nothing is lost by it; otherwise it waits under Drafts. */
	const openRestored = useCallback((restoredId: string) => {
		// Nor while another message is on its way: the offer then says "under Drafts", which is true.
		if (occupied.current.size > 0 || sending.current > 0) return false;
		// The page composer takes its message back itself; a second window on top of it would be one too many.
		if (restoreTarget.current) restoreTarget.current(restoredId); else openDraftComposer(restoredId);
		return true;
	}, [openDraftComposer]);
	// The offers and the application's notices share a corner: the notices are told how much room
	// the offers take and stand above them (`.status-stack`, globals.css).
	const undoStack = useRef<HTMLDivElement | null>(null);
	const offers = pendingUndos.length;
	useEffect(() => {
		const stack = undoStack.current;
		const root = document.documentElement;
		if (!offers || !stack) return;
		const tell = () => root.style.setProperty("--undo-stack-space", `${Math.ceil(stack.getBoundingClientRect().height) + 8}px`);
		tell();
		root.setAttribute("data-undo-offers", "");
		const observer = new ResizeObserver(tell);
		observer.observe(stack);
		return () => {
			observer.disconnect();
			root.removeAttribute("data-undo-offers");
			root.style.removeProperty("--undo-stack-space");
		};
	}, [offers]);
	const value = useMemo<ComposeContextValue>(() => ({
		open,
		draftId,
		prefill,
		composeId,
		freshReply,
		// Takes no argument on purpose: it is used directly as a click handler.
		openComposer: () => {
			const fresh = () => {
				setPrefill(null);
				setFreshReply(false);
				setDraftId(null);
				setOpen(true);
			};
			if (waitsForSend()) blockedOpen.current = { draftId: null, open: fresh }; else fresh();
		},
		openComposerWith: (next) => {
			// Nor while a message is on its way: the caller then opens the link in a tab of its own.
			if (occupied.current.size > 0 || sending.current > 0) return false;
			setPrefill(next);
			setComposeId((current) => current + 1);
			setFreshReply(false);
			setDraftId(null);
			setOpen(true);
			return true;
		},
		openDraftComposer,
		closeComposer: () => {
			setOpen(false);
			setDraftId(null);
			setPrefill(null);
			setFreshReply(false);
		},
		offerUndoSend: (messageId, remainingMs, recipient, subject) => setPendingUndos((current) => [...current.filter((entry) => entry.messageId !== messageId), { messageId, until: Date.now() + remainingMs, recipient, subject }]),
		reportOccupied,
		isOccupied,
		setRestoreTarget,
		setSending,
	}), [setRestoreTarget, setSending, waitsForSend, composeId, draftId, freshReply, isOccupied, open, openDraftComposer, prefill, reportOccupied]);

	return (
		<ComposeContext.Provider value={value}>
			{children}
			{pendingUndos.length > 0 && createPortal(
				// In the bottom left corner beside the desktop composer. Where the composer fills the screen
				// (phones, tablets), globals.css lifts the offers above the composer's send bar instead.
				<div ref={undoStack} data-compose-layer data-undo-send-stack className="fixed bottom-6 left-6 z-[180] flex max-w-[calc(100vw-32px)] flex-col items-start gap-2">
					<Suspense fallback={null}>
						{pendingUndos.map((pending) => (
							<UndoSendToast key={pending.messageId} pending={pending} named={pendingUndos.length > 1} onDone={endUndoOffer} onRestored={openRestored} />
						))}
					</Suspense>
				</div>,
				document.body,
			)}
		</ComposeContext.Provider>
	);
}
