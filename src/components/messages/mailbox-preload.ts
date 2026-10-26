import { AUTH_SESSION_CHANGED_EVENT, getClientSessionToken } from "@/lib/auth/client";
import { fetchMessageList, getCachedMessageList, getMessageClientGeneration, hasPendingMessageRequests } from "@/hooks/utils";
import { getMailboxPageParams } from "@/components/components-nav-utils";
import { fetchMailboxFolders } from "./use-mailbox-folders";

const FOLDERS = ["all", "invoices", "promotions", "social", "orders", "inbox", "starred", "archived", "sent", "drafts", "snoozed", "scheduled", "spam", "trash"];
type Connection = EventTarget & { saveData?: boolean; effectiveType?: string };
type Options = { mailboxId: string; href: string; grouped: boolean; prefetchRoute: (href: string) => void; preloadReader?: () => Promise<void> };

/** One low-priority first page at a time, after the visible list has painted. */
export function startMailboxPreload({ mailboxId, href, grouped, prefetchRoute, preloadReader }: Options): () => void {
	const generation = getMessageClientGeneration(), token = getClientSessionToken();
	const connection = (navigator as Navigator & { connection?: Connection }).connection;
	const targets = FOLDERS.map(folder => `/${folder}`).filter(target => target !== href);
	let stopped = false, running = false, labelsLoaded = false, index = 0;
	let readerLoaded = !preloadReader;
	let quietUntil = Date.now() + 750;
	let timer: number | undefined, idle: number | undefined;
	const current = () => !stopped && generation === getMessageClientGeneration() && token === getClientSessionToken();
	const allowed = () => current() && document.visibilityState === "visible" && navigator.onLine !== false && !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
	function cancelScheduled() {
		window.clearTimeout(timer);
		if (idle !== undefined) window.cancelIdleCallback?.(idle);
		timer = idle = undefined;
	}
	function schedule() {
		cancelScheduled();
		if (!allowed() || running) return;
		timer = window.setTimeout(() => {
			timer = undefined;
			if (window.requestIdleCallback) idle = window.requestIdleCallback(() => { idle = undefined; void step(); }, { timeout: 1500 });
			else void step();
		}, Math.max(250, quietUntil - Date.now()));
	}
	async function step() {
		if (!allowed()) return;
		if (Date.now() < quietUntil || hasPendingMessageRequests()) { schedule(); return; }
		if (!readerLoaded) {
			readerLoaded = running = true;
			try { await preloadReader?.(); }
			catch { quietUntil = Date.now() + 3000; /* A click retries failed code loading. */ }
			finally { running = false; schedule(); }
			return;
		}
		while (index < targets.length) {
			const target = targets[index++];
			const params = getMailboxPageParams(target, mailboxId, grouped);
			if (!params || getCachedMessageList(params)) continue;
			running = true;
			try {
				// Route prefetch never mounts the page or executes its client-side effects.
				try { prefetchRoute(target); } catch { /* Data can still be warmed. */ }
				await fetchMessageList(params, false, true);
			} catch { quietUntil = Date.now() + 3000; /* A failed warm-up remains retryable on navigation. */ }
			finally { running = false; schedule(); }
			return;
		}
		if (!labelsLoaded) {
			labelsLoaded = running = true;
			try {
				const folders = await fetchMailboxFolders(mailboxId);
				if (current()) targets.push(...folders.map(folder => `/folders/${encodeURIComponent(folder.id)}`).filter(target => target !== href));
			} catch { /* The sidebar or a later visit can retry label definitions. */ }
			finally { running = false; if (current() && index < targets.length) schedule(); else stop(); }
		}
		else stop();
	}
	function onInteraction() { quietUntil = Date.now() + 750; schedule(); }
	function onStorage() { if (!current()) stop(); }
	function stop() {
		stopped = true;
		cancelScheduled();
		for (const event of ["pointerdown", "keydown", "wheel", "touchmove", "online"]) window.removeEventListener(event, onInteraction);
		document.removeEventListener("visibilitychange", onInteraction);
		connection?.removeEventListener("change", onInteraction);
		window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, stop);
		window.removeEventListener("storage", onStorage);
		window.removeEventListener("mailflare:messages-changed", onInteraction);
	}
	for (const event of ["pointerdown", "keydown", "wheel", "touchmove", "online"]) window.addEventListener(event, onInteraction, { passive: true });
	document.addEventListener("visibilitychange", onInteraction);
	connection?.addEventListener("change", onInteraction);
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, stop);
	window.addEventListener("storage", onStorage);
	window.addEventListener("mailflare:messages-changed", onInteraction);
	schedule();
	return stop;
}
