import { useState } from "react";
import type { Message } from "@/hooks/types";
import { runBulkMessageAction } from "./utils";

type Entry = { operation: object; pending: boolean };
type ArchiveState = { scope: string; rows: Map<string, Entry>; failed: boolean };

/** Keep archived rows hidden through pending/stale refreshes; undo only a failed row. */
export function useOptimisticArchive(source: Message[], sourceTotal: number, scope: string) {
	const [state, setState] = useState<ArchiveState>(() => ({ scope, rows: new Map(), failed: false }));
	let current = state;
	if (state.scope !== scope) {
		current = { scope, rows: new Map(), failed: false };
		setState(current);
	} else {
		const ids = new Set(source.map(message => message.id));
		const confirmed = [...state.rows].filter(([id, entry]) => !entry.pending && !ids.has(id));
		if (confirmed.length) {
			const rows = new Map(state.rows);
			for (const [id] of confirmed) rows.delete(id);
			current = { ...state, rows };
			setState(current);
		}
	}
	const messages = source.filter(message => !current.rows.has(message.id));
	const total = Math.max(0, sourceTotal - (source.length - messages.length));

	async function archiveRow(message: Message) {
		const operation = {};
		setState(previous => ({
			scope,
			rows: new Map(previous.scope === scope ? previous.rows : []).set(message.id, { operation, pending: true }),
			failed: false,
		}));
		try {
			await runBulkMessageAction(message.threadMessageIds ?? [message.id], "archive");
			setState(previous => {
				if (previous.scope !== scope || previous.rows.get(message.id)?.operation !== operation) return previous;
				return { ...previous, rows: new Map(previous.rows).set(message.id, { operation, pending: false }) };
			});
		} catch (error) {
			setState(previous => {
				if (previous.scope !== scope || previous.rows.get(message.id)?.operation !== operation) return previous;
				const rows = new Map(previous.rows);
				rows.delete(message.id);
				return { ...previous, rows, failed: true };
			});
			throw error;
		}
	}

	return { messages, total, archiveRow, archiveFailed: current.failed };
}
