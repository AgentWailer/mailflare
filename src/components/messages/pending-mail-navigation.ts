let pending = false;

/** Native history does not cancel a router request already in flight. */
export function markPendingMailNavigation(): void {
	pending = true;
}

export function clearPendingMailNavigation(): void {
	pending = false;
}

export function hasPendingMailNavigation(): boolean {
	return pending;
}
