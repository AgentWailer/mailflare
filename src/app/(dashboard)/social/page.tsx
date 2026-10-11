"use client";

import { socialFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function SocialPage() {
	return <MessageFolderPage config={socialFolderConfig} />;
}
