"use client";

import { allMailFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageSplitLayout } from "@/components/messages/message-split-layout";

export default function AllMailLayout({ children }: { children: React.ReactNode }) {
	return <MessageSplitLayout config={allMailFolderConfig}>{children}</MessageSplitLayout>;
}
