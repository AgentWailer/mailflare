"use client";

import { allMailFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function AllMailPage() {
	return <MessageFolderPage config={allMailFolderConfig} />;
}
