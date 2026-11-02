"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RouteLoadingBar } from "./route-loading-bar";

// Pinned to the viewport top even when an ancestor's transform (e.g. a page transition) would otherwise become the fixed containing block.
export function RouteLoadingBarPortal() {
	const [mounted, setMounted] = useState(false);
	// eslint-disable-next-line react-hooks/set-state-in-effect -- The portal target only exists in the browser; preserve matching initial SSR markup.
	useEffect(() => setMounted(true), []);
	if (!mounted) return <RouteLoadingBar />;
	return createPortal(<RouteLoadingBar />, document.body);
}
