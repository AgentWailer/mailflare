"use client";

import { createContext, useContext } from "react";
import type { Message } from "@/hooks/types";

export const MessageOpeningContext = createContext<{
	pendingMessageId: string | null;
	open(message: Message, href: string): void;
	cancel(): void;
} | null>(null);

export const useMessageOpening = () => useContext(MessageOpeningContext);
