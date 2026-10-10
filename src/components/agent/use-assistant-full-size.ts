"use client";

import { useSyncExternalStore } from "react";

const query = "(max-width: 1023px)";
function subscribe(onChange: () => void) {
	const media = window.matchMedia(query);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}
const getSnapshot = () => window.matchMedia(query).matches;
const getServerSnapshot = () => false;

// A side panel leaves too little room for the message on phones and small tablets.
export function useAssistantFullSize(requested: boolean) {
	const narrow = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	return requested || narrow;
}
