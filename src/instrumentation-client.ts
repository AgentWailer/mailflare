import { markPendingMailNavigation } from "./components/messages/pending-mail-navigation";

/** Public router hook covers links, shortcuts and programmatic navigation. */
export function onRouterTransitionStart(): void {
	markPendingMailNavigation();
}
