"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { UndoSendToast } from "./undo-send-toast";

/** A message that was just sent with an undo window and has not been delivered yet. */
export type PendingUndoSend = { messageId: string; until: number };

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	openComposer: () => void;
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

	const openDraftComposer = useCallback((nextDraftId: string) => {
		setDraftId(nextDraftId);
		setOpen(true);
	}, []);
	const value = useMemo<ComposeContextValue>(() => ({
		open,
		draftId,
		openComposer: () => {
			setDraftId(null);
			setOpen(true);
		},
		openDraftComposer,
		closeComposer: () => {
			setOpen(false);
			setDraftId(null);
		},
		offerUndoSend: (messageId, seconds) => setPendingUndo({ messageId, until: Date.now() + seconds * 1000 }),
	}), [draftId, open, openDraftComposer]);

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
