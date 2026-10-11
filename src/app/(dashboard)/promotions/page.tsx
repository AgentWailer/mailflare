"use client";

import { promotionsFolderConfig } from "@/components/messages/message-folder-configs";
import { MessageFolderPage } from "@/components/messages/message-folder-page";

export default function PromotionsPage() {
	return <MessageFolderPage config={promotionsFolderConfig} />;
}
