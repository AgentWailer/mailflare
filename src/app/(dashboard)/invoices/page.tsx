"use client";

import { invoicesFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function InvoicesPage() {
	return <MessageFolderPage config={invoicesFolderConfig} />;
}
