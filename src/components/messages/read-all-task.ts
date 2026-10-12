"use client";

import { useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch, getClientSessionToken } from "@/lib/auth/client";
import { getMessageQueryParams } from "@/hooks/utils";
import { clearMessageDetailCache, setCachedMessageRead } from "@/lib/messages/detail-cache";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MailCategory } from "@/lib/mail-sorting/categories";
import type { MessageFolder } from "@/hooks/types";

export type BulkScope = { folder: MessageFolder; mailboxId?: string; folderId?: string; query: string; unreadOnly: boolean; title: string };
type Chunk = { messageIds: string[]; done: boolean; total?: number; snapshot: number; after: number; actorId: string; mailboxIds: string[] };
export type BulkScopeSelection = { snapshot: number; actorId: string; mailboxIds: string[]; after: number; total: number; unread: number; canManage: boolean };
export type OrganizationChanges = { addLabelIds?: string[]; removeLabelIds?: string[]; category?: MailCategory; skipInbox?: boolean };
export type ScopeAction = BulkMessageAction | "organize";
export type ReadAllTask = { action: ScopeAction; destinationFolderId?: string; organization?: OrganizationChanges; legacy?: boolean; scope: BulkScope; status: "running" | "failed" | "done"; processed: number; total?: number };
let task: ReadAllTask | null = null;
let continuation: Pick<Chunk, "snapshot" | "after" | "actorId" | "mailboxIds"> | undefined;
let session: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: ReadAllTask | null) => { task = next; for (const listener of listeners) listener(); };
if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, () => publish(null));
	window.addEventListener("storage", () => { if (session !== getClientSessionToken()) publish(null); });
}
const emptySnapshot = () => null;
export function useReadAllTask() { return useSyncExternalStore(subscribe, () => task, emptySnapshot); }
export function dismissReadAllTask() { if (task?.status !== "running") publish(null); }

// Independent of the page component: switching folders does not abandon the operation.
// Closing/reloading the browser stops it; completed chunks are retained and safe to repeat.
export async function prepareBulkScopeSelection(scope: BulkScope): Promise<BulkScopeSelection> {
	const selectedSession = getClientSessionToken();
	const response = await authFetch("/api/messages/bulk-scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...scopePayload(scope), action: "select" }), signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error("Could not select all matching messages");
	const result = await response.json() as BulkScopeSelection;
	if (selectedSession !== getClientSessionToken()) throw new Error("Session changed");
	return result;
}
function scopePayload(scope: BulkScope) {
	const params = getMessageQueryParams(scope.folder, scope.mailboxId, { query: scope.query, read: scope.unreadOnly ? "unread" : "all" }, scope.folderId);
	return { folder: scope.folder, mailboxId: scope.mailboxId, folderId: scope.folderId, q: params.get("q") ?? undefined, read: params.get("read") ?? undefined, timeZone: params.get("timeZone") ?? undefined };
}
export function startBulkScopeTask(scope: BulkScope, selection: BulkScopeSelection, action: ScopeAction, destinationFolderId?: string, organization?: OrganizationChanges) {
	if (task?.status === "running") return;
	session = getClientSessionToken();
	continuation = { snapshot: selection.snapshot, after: 0, actorId: selection.actorId, mailboxIds: selection.mailboxIds };
	publish({ scope, action, destinationFolderId, organization, status: "running", processed: 0, total: selection.total });
	void run();
}
export function startReadAllTask(scope: BulkScope) {
	if (task?.status === "running") return;
	session = getClientSessionToken();
	continuation = undefined;
	publish({ scope, action: "read", legacy: true, status: "running", processed: 0 });
	void run();
}
export function retryReadAllTask() {
	if (task?.status !== "failed" || session !== getClientSessionToken()) { dismissReadAllTask(); return; }
	publish({ ...task, status: "running" });
	void run();
}
async function run() {
	if (!task) return;
	const scope = task.scope;
	const taskSession = session;
	const operation = task;
	let pendingIds: string[] = [];
	let lastRefresh = 0;
	const reconcile = () => {
		if (taskSession !== getClientSessionToken() || task?.scope !== scope) { pendingIds = []; return; }
		if (operation.action === "read" || operation.action === "unread") for (const id of pendingIds) setCachedMessageRead(id, operation.action === "read");
		else if (pendingIds.length) clearMessageDetailCache();
		pendingIds = [];
		window.dispatchEvent(new Event("mailflare:messages-changed"));
		lastRefresh = Date.now();
	};
	try {
		while (task?.status === "running") {
			if (task?.scope !== scope) return;
			if (taskSession !== getClientSessionToken()) { publish(null); return; }
			const response = await authFetch(operation.legacy ? "/api/messages/read-all" : "/api/messages/bulk-scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
				...scopePayload(scope), ...continuation,
				...(!operation.legacy ? { action: operation.action, destinationFolderId: operation.destinationFolderId, organization: operation.organization } : {}),
			}), signal: AbortSignal.timeout(30000) });
			if (task?.scope !== scope) return;
			if (taskSession !== getClientSessionToken()) { publish(null); return; }
			if (!response.ok) throw new Error("Read-all request failed");
			const chunk = await response.json() as Chunk;
			if (task?.scope !== scope) return;
			if (taskSession !== getClientSessionToken()) { publish(null); return; }
			continuation = { snapshot: chunk.snapshot, after: chunk.after, actorId: chunk.actorId, mailboxIds: chunk.mailboxIds };
			pendingIds.push(...chunk.messageIds);
			publish({ ...task, processed: task.processed + chunk.messageIds.length, total: chunk.total ?? task.total, status: chunk.done ? "done" : "running" });
			if (chunk.done || Date.now() - lastRefresh > 1500) reconcile();
			if (chunk.done) return;
			// Leave breathing room for input/rendering and other mailbox requests.
			await new Promise(resolve => setTimeout(resolve, 75));
		}
	} catch {
		// A lost response may already have committed a chunk whose IDs we never received.
		if (task?.scope === scope && taskSession === getClientSessionToken()) clearMessageDetailCache();
		reconcile();
		if (task?.scope !== scope) return;
		if (taskSession !== getClientSessionToken()) publish(null);
		else if (task) publish({ ...task, status: "failed" });
	}
}
