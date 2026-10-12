"use client";

import { invoicesFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function InvoicesLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<MessageSplitLayout config={invoicesFolderConfig}>
			{children}
		</MessageSplitLayout>
	);
}
