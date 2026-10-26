import type { ReactNode } from "react";
import type { MessageNavigationEntry } from "@/app/api/messages/navigation/types";
import type { MessageNavigationWindow } from "@/app/api/messages/navigation/types";
import type { MessageFolderConfig } from "./types";

export type MessageDetailNavigationProviderProps = {
	children: ReactNode;
	config: MessageFolderConfig;
	messageId?: string;
};

export type MessageDetailNavigationProps = {
	messageId: string;
};

export type MessageDetailNavigationSnapshot = {
	key: string;
	entries: MessageNavigationEntry[];
	navigation?: MessageNavigationWindow;
};

export type MessageDetailNavigationContextValue = {
	entries: MessageNavigationEntry[];
	navigation?: MessageNavigationWindow;
	hrefPrefix: string;
};

export type MessageDetailNavigationState = {
	previousId: string | null;
	nextId: string | null;
	position: number;
	total: number;
};
