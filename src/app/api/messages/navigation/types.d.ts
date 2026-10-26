export type MessageNavigationEntry = {
	id: string;
	unread: boolean;
};

export type MessageNavigationResponse = {
	messages: MessageNavigationEntry[];
	navigation?: MessageNavigationWindow;
};

export type MessageNavigationWindow = { previousId: string | null; nextId: string | null; position: number; total: number };
