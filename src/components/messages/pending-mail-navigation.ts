let pending: "route" | "traverse" | null = null;

/** Native history does not cancel a router request already in flight. */
export function markPendingMailNavigation(type: "push" | "replace" | "traverse"): void {
	pending = type === "traverse" ? "traverse" : "route";
}

export function clearPendingMailNavigation(): void {
	// A same-tree Back/Forward commit can leave an older reader RSC in flight.
	// Keep the next category on the router so it supersedes that request. A real
	// push/replace owns a new route and releases this guard when it commits.
	if (pending !== "traverse") pending = null;
}

export function hasPendingMailNavigation(): boolean {
	return pending !== null;
}
