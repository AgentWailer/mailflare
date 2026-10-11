"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

/** iOS does not consistently resize fixed elements when the software keyboard opens. */
export function useComposeViewport(ref: RefObject<HTMLFormElement | null>, active: boolean, mode: "popup" | "page" = "popup") {
	useEffect(() => {
		const element = ref.current;
		const viewport = window.visualViewport;
		if (!active || !element || !viewport) return;
		function update() {
			const height = mode === "page" ? Math.max(0, viewport!.height + viewport!.offsetTop - element!.getBoundingClientRect().top - 8) : viewport!.height;
			element!.style.setProperty("--compose-viewport-height", `${height}px`);
			element!.style.setProperty("--compose-viewport-top", `${viewport!.offsetTop}px`);
		}
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			element.style.removeProperty("--compose-viewport-height");
			element.style.removeProperty("--compose-viewport-top");
		};
	}, [ref, active, mode]);
}
