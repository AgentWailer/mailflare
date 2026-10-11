import type { MessageNavigationEntry } from "@/app/api/messages/navigation/types";
import type { MessageDetailNavigationState } from "./message-detail-navigation-types";

export function getMessageDetailNavigationState(entries: MessageNavigationEntry[], currentId: string): MessageDetailNavigationState {
	// Match the list's chronological order; reading a message must not move the arrows.
	const index = entries.findIndex((entry) => entry.id === currentId);
	return {
		previousId: index > 0 ? entries[index - 1].id : null,
		nextId: index >= 0 ? entries[index + 1]?.id ?? null : null,
		position: index >= 0 ? index + 1 : 0,
		total: entries.length,
	};
}
