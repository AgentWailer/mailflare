type PendingNavigation = { kind: "route" | "traverse"; pathname: string | null; generation: number };
let pending: PendingNavigation | null = null;
let generation = 0;
let recoveryGeneration: number | null = null;

/** Native history does not cancel a router request already in flight. */
export function markPendingMailNavigation(type: "push" | "replace" | "traverse", pathname: string | null): void {
	const recovery = type === "replace" && pending?.generation === recoveryGeneration;
	pending = { kind: type === "traverse" || recovery ? "traverse" : "route", pathname, generation: ++generation };
	recoveryGeneration = null;
}

export function clearPendingMailNavigation(pathname: string): void {
	// A same-tree Back/Forward commit can leave an older reader RSC in flight.
	// Keep the next category on the router so it supersedes that request. A real
	// push/replace owns a new route and releases this guard when it commits.
	if (pending?.kind === "route" && pending.pathname === pathname) pending = null;
}

export function hasPendingMailNavigation(): boolean {
	return pending !== null;
}

export function getPendingMailTraversal(): number | null {
	return pending?.kind === "traverse" ? pending.generation : null;
}

/** A same-URL recovery must remain guarded even if the Back layout commits. */
export function recoverPendingMailTraversal(token: number, replace: () => void): void {
	if (getPendingMailTraversal() !== token) return;
	recoveryGeneration = token;
	try { replace(); }
	finally { recoveryGeneration = null; }
}
