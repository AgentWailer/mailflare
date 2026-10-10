"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

/** iOS does not consistently resize fixed elements when the software keyboard opens. */
export function useComposeViewport(ref: RefObject<HTMLFormElement | null>, active: boolean) {
	useEffect(() => {
		const element = ref.current;
		const viewport = window.visualViewport;
		if (!active || !element || !viewport) return;
		function update() {
			element!.style.setProperty("--compose-viewport-height", `${viewport!.height}px`);
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
	}, [ref, active]);
}
