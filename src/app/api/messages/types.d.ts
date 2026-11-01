import type { getTableColumns, SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import type { messages } from "@/db/schema";

export type ListMessage = Omit<typeof messages.$inferSelect, "textBody" | "htmlBody" | "headerMetadata">;

export type MessageListColumns = Omit<ReturnType<typeof getTableColumns<typeof messages>>, "textBody" | "htmlBody" | "headerMetadata">;

export type ConversationPageInput = {
	db: AppDatabase;
	where: SQL | undefined;
	offset: number;
	limit: number;
};

export type ConversationPage = {
	ids: string[];
	total: number;
};
