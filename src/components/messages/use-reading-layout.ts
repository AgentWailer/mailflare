"use client";

import { useCallback, useLayoutEffect, useState } from "react";

export type ReadingLayout = "bottom" | "right" | "off";
const STORAGE_KEY = "mailflare-reading-layout";
const CHANGE_EVENT = "mailflare:reading-layout-changed";

export function readReadingLayout(): ReadingLayout {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "bottom" || saved === "right" || saved === "off") return saved;
		return localStorage.getItem("mailflare-two-column-reading") === "off" ? "off" : "bottom";
	} catch {
		return "bottom";
	}
}

export function useReadingLayout(): [ReadingLayout, (layout: ReadingLayout) => void] {
	const [layout, setLayout] = useState<ReadingLayout>("bottom");
	useLayoutEffect(() => {
		const sync = () => setLayout(readReadingLayout());
		sync();
		window.addEventListener(CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);
	const update = useCallback((next: ReadingLayout) => {
		try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage is optional. */ }
		window.dispatchEvent(new Event(CHANGE_EVENT));
		setLayout(next);
	}, []);
	return [layout, update];
}
