"use client";

import { ordersFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function OrdersPage() {
	return <MessageFolderPage config={ordersFolderConfig} />;
}
