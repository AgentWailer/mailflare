"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ComposePrefill } from "./mailto-utils";
import { UndoSendToast } from "./undo-send-toast";

/** A message that was just sent with an undo window and has not been delivered yet. */
export type PendingUndoSend = { messageId: string; until: number };

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	/** What a new message starts with when it was opened from a link, and a number that changes with each such opening. */
	prefill: ComposePrefill | null;
	composeId: number;
	openComposer: () => void;
	/** A new message that starts with these recipients, subject and text, e.g. from a mailto link. */
	openComposerWith: (prefill: ComposePrefill) => void;
	openDraftComposer: (draftId: string) => void;
	closeComposer: () => void;
	/** Offer to take `messageId` back for `seconds`; the offer outlives the composer that sent it. */
	offerUndoSend: (messageId: string, seconds: number) => void;
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
	const [pendingUndo, setPendingUndo] = useState<PendingUndoSend | null>(null);
	const [prefill, setPrefill] = useState<ComposePrefill | null>(null);
	const [composeId, setComposeId] = useState(0);

	const openDraftComposer = useCallback((nextDraftId: string) => {
		setPrefill(null);
		setDraftId(nextDraftId);
		setOpen(true);
	}, []);
	const value = useMemo<ComposeContextValue>(() => ({
		open,
		draftId,
		prefill,
		composeId,
		// Takes no argument on purpose: it is used directly as a click handler.
		openComposer: () => {
			setPrefill(null);
			setDraftId(null);
			setOpen(true);
		},
		openComposerWith: (next) => {
			setPrefill(next);
			setComposeId((current) => current + 1);
			setDraftId(null);
			setOpen(true);
		},
		openDraftComposer,
		closeComposer: () => {
			setOpen(false);
			setDraftId(null);
			setPrefill(null);
		},
		offerUndoSend: (messageId, seconds) => setPendingUndo({ messageId, until: Date.now() + seconds * 1000 }),
	}), [composeId, draftId, open, openDraftComposer, prefill]);

	return (
		<ComposeContext.Provider value={value}>
			{children}
			{pendingUndo && (
				<UndoSendToast
					key={pendingUndo.messageId}
					pending={pendingUndo}
					onDone={() => setPendingUndo((current) => (current?.messageId === pendingUndo.messageId ? null : current))}
					onRestored={openDraftComposer}
				/>
			)}
		</ComposeContext.Provider>
	);
}
