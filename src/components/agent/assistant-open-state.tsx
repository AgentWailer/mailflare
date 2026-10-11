"use client";

import { createContext, useContext } from "react";

export const AssistantOpenContext = createContext(false);
export type MessageAssistantRequest = { mailboxId: string; messageId: string; action: "summary" | "translate"; prompt: string };
export const AssistantRequestContext = createContext<((request: MessageAssistantRequest) => void) | null>(null);

export function useAssistantOpen() {
	return useContext(AssistantOpenContext);
}
