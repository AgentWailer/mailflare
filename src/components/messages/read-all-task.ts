"use client";

import { useSyncExternalStore } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch, getClientSessionToken } from "@/lib/auth/client";
import { getMessageQueryParams } from "@/hooks/utils";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MailCategory } from "@/lib/mail-sorting/categories";
import type { MessageFolder } from "@/hooks/types";

export type BulkScope = { folder: MessageFolder; mailboxId?: string; folderId?: string; query: string; unreadOnly: boolean; title: string };
export type BulkScopeSelection = { snapshot: number; actorId: string; mailboxIds: string[]; after: number; total: number; unread: number; canManage: boolean; inboxPolicy?: "primary_only" | "relevant" };
export type OrganizationChanges = { addLabelIds?: string[]; removeLabelIds?: string[]; category?: MailCategory; skipInbox?: boolean };
export type ScopeAction = BulkMessageAction | "organize";
export type ReadAllTask = { id?: string; requestId?: string; canRetry?: boolean; error?: string; action: ScopeAction | "applyRule"; destinationFolderId?: string; organization?: OrganizationChanges; scope: BulkScope; status: "running" | "failed" | "done"; processed: number; total?: number };
let task: ReadAllTask | null = null, pending: { input: unknown; scope: BulkScope; requestId: string } | null = null;
let session: string | null = null, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, submitting = false;
let readingGeneration: number | null = null;
const listeners = new Set<() => void>();
const publish = (next: ReadAllTask | null) => { task = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); if (listeners.size === 1) void refreshBulkTask(); return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(timer); timer = undefined; } }; };
const emptySnapshot = () => null;
function schedule() { clearTimeout(timer); if (listeners.size) timer = setTimeout(() => void refreshBulkTask(), task?.status === "running" ? 2000 : 15000); }
function changed() { clearMessageDetailCache(); window.dispatchEvent(new Event("mailflare:messages-changed")); }
/** Only observe the server job. Closing this subscriber never cancels its queue work. */
export async function refreshBulkTask() {
 if (!listeners.size) return;
 const token = getClientSessionToken(), version = generation;
 if (submitting || readingGeneration === version) { schedule(); return; }
 readingGeneration = version;
 try {
  const response = await authFetch("/api/messages/bulk-jobs", { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) return;
  const result = await response.json() as { job?: ReadAllTask | null };
  const job = result.job ?? null;
  if (token !== getClientSessionToken() || version !== generation || submitting) return;
  // A failed submission retains its retry payload unless the same request reached the server.
  if (pending && task?.status === "failed" && job?.requestId !== pending.requestId) return;
  if (job && (job.id !== task?.id || job.processed !== task?.processed || job.status !== task?.status)) changed();
  session = token;publish(job);
 } catch { /* A network failure does not interrupt server processing. */ }
 finally { if (readingGeneration === version) readingGeneration = null; if (version === generation) schedule(); }
}
if (typeof window !== "undefined") {
 const reset = () => { generation++; clearTimeout(timer);submitting = false; pending = null; session = getClientSessionToken();publish(null);if (session) void refreshBulkTask(); };
 window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
 window.addEventListener("storage", () => { if (session !== getClientSessionToken()) reset(); });
 window.addEventListener("focus", () => void refreshBulkTask());
 window.addEventListener("online", () => void refreshBulkTask());
 document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void refreshBulkTask(); });
}
export function useReadAllTask() {
 return useSyncExternalStore(subscribe, () => task, emptySnapshot);
}
export function dismissReadAllTask() {
 if (task?.status === "running") return;
 generation++;
 const id = task?.id; pending = null;publish(null);
 if (id) void control(id, "dismiss");
}
async function control(id: string, action: "retry" | "dismiss") {
 const token = getClientSessionToken(), version = generation;
 try {
  const response = await authFetch("/api/messages/bulk-jobs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }), signal: AbortSignal.timeout(15000) });
  const { job } = await response.json() as { job?: ReadAllTask };
  if (response.ok && token === getClientSessionToken() && version === generation && action === "retry" && job) publish(job);
 } catch { /* Keep the persisted task available for another retry. */ }
 schedule();
}
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
 generation++;
 session = getClientSessionToken();
 const requestId = crypto.randomUUID();
 pending = { input: { ...scopePayload(scope), snapshot: selection.snapshot, actorId: selection.actorId, mailboxIds: selection.mailboxIds, inboxPolicy: selection.inboxPolicy ?? "primary_only", action, destinationFolderId, organization }, scope, requestId };
 publish({ scope, action, destinationFolderId, organization, requestId, status: "running", processed: 0, total: selection.total });
 void submit();
}
export function startReadAllTask(scope: BulkScope) {
 if (task?.status === "running") return;
 generation++;
 session = getClientSessionToken();const requestId = crypto.randomUUID();
 pending = { input: { ...scopePayload(scope), action: "read", inboxPolicy: "relevant" }, scope, requestId };
 publish({ scope, action: "read", requestId, status: "running", processed: 0 });void submit();
}
export function retryReadAllTask() {
 if (task?.status !== "failed" || session !== getClientSessionToken()) return;
 if (task.id) { void control(task.id, "retry");return; }
 if (pending) { publish({ ...task, status: "running" });void submit(); }
}
async function submit() {
 if (!pending || submitting) return;
 submitting = true;const request = pending, token = session, version = generation;
 try {
  const response = await authFetch("/api/messages/bulk-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), keepalive: true, signal: AbortSignal.timeout(30000) });
  const { job, error } = await response.json() as { job?: ReadAllTask; error?: string };
  if (token !== getClientSessionToken() || version !== generation) return;
  if (!response.ok || !job) throw new Error(error ?? "Background action could not start");
  pending = null;publish(job);changed();
 } catch {
  if (token === getClientSessionToken() && version === generation && task) publish({ ...task, status: "failed" });
 } finally {
  if (version === generation) { submitting = false;void refreshBulkTask(); }
 }
}

/** Adopt a durable rule job accepted by the dedicated, authorized rule endpoint. */
export function observeRuleTask(job: ReadAllTask) {
 generation++; pending = null; submitting = false; session = getClientSessionToken();
 publish(job); changed(); schedule();
}
