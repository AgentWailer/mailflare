/**
 * A visitor who opens the assistant from its toggle wants to type into it. The request is remembered so a panel
 * that is still loading (it is fetched on first open) can honour it when it mounts; a panel restored open on
 * page load never asked, so it never steals focus.
 */
export const ASSISTANT_FOCUS_EVENT = "mailflare:assistant-focus";
let pending = false;

export function requestAssistantFocus() {
	pending = true;
	window.dispatchEvent(new Event(ASSISTANT_FOCUS_EVENT));
}

export function consumeAssistantFocus(): boolean {
	const requested = pending;
	pending = false;
	return requested;
}
