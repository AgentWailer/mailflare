"use client";

import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState } from "react";
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
	 * other message is opened: the same draft opened again could be sent a second time.
	 */
	setSending: (sending: boolean) => void;
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
	const sending = useRef(false);
	const setSending = useCallback((value: boolean) => { sending.current = value; }, []);
	/** True, and says so, while a send is under way: opening another message has to wait for its answer. */
	const waitsForSend = useCallback(() => {
		if (sending.current) announceStatus("compose.sendingBusy");
		return sending.current;
	}, []);
	const restoreTarget = useRef<((draftId: string) => void) | null>(null);
	const setRestoreTarget = useCallback((target: ((draftId: string) => void) | null) => { restoreTarget.current = target; }, []);

	const openDraftComposer = useCallback((nextDraftId: string, options?: { freshReply?: boolean }) => {
		if (waitsForSend()) return;
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
		if (occupied.current.size > 0) return false;
		// The page composer takes its message back itself; a second window on top of it would be one too many.
		if (restoreTarget.current) restoreTarget.current(restoredId); else openDraftComposer(restoredId);
		return true;
	}, [openDraftComposer]);
	const value = useMemo<ComposeContextValue>(() => ({
		open,
		draftId,
		prefill,
		composeId,
		freshReply,
		// Takes no argument on purpose: it is used directly as a click handler.
		openComposer: () => {
			if (waitsForSend()) return;
			setPrefill(null);
			setFreshReply(false);
			setDraftId(null);
			setOpen(true);
		},
		openComposerWith: (next) => {
			if (occupied.current.size > 0) return false;
			if (waitsForSend()) return true;
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
				<div data-compose-layer data-undo-send-stack className="fixed bottom-6 left-6 z-[180] flex max-w-[calc(100vw-32px)] flex-col items-start gap-2">
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
