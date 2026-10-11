"use client";

import { socialFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function SocialLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<MessageSplitLayout config={socialFolderConfig}>
			{children}
		</MessageSplitLayout>
	);
}
