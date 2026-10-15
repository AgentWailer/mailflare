"use client";

import { lazy, Suspense, useState } from "react";
import { ConversationSkeleton } from "./conversation-skeleton";
import type { AgentPanelProps } from "./types";

const AgentPanel = lazy(() => import("./agent-panel").then(module => ({ default: module.AgentPanel })));

/** Do not download Markdown/chat code for a closed assistant; retain its state after first use. */
export function DeferredAgentPanel(props: AgentPanelProps) {
	const [visited, setVisited] = useState(props.open);
	if (props.open && !visited) setVisited(true);
	if (!props.open && !visited) return null;
	return <Suspense fallback={<ConversationSkeleton />}><AgentPanel {...props} /></Suspense>;
}
