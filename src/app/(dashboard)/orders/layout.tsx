"use client";

import { ordersFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function OrdersLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<MessageSplitLayout config={ordersFolderConfig}>
			{children}
		</MessageSplitLayout>
	);
}
