import type { MouseEvent } from "react";

export type MessageNavigationState = {
	progress: number | null;
	onIntent(): void;
	onHover(): void;
	onLeave(): void;
	onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead?: boolean): void;
};
