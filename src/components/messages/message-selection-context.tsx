"use client";

import { createContext, useContext } from "react";
import type { MessageSelectionControl } from "./types";

export const MessageSelectionContext = createContext<MessageSelectionControl | null>(null);
export const useMessageSelection = () => useContext(MessageSelectionContext);
