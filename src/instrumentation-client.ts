import { markPendingMailNavigation } from "./components/messages/pending-mail-navigation";

/** Public router hook covers links, shortcuts and programmatic navigation. */
export function onRouterTransitionStart(href: string, type: "push" | "replace" | "traverse"): void {
	let pathname: string | null = null;
	try { pathname = new URL(href, window.location.href).pathname; }
	catch { /* Keep an unknown destination guarded rather than breaking navigation. */ }
	markPendingMailNavigation(type, pathname);
}
