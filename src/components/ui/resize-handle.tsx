"use client";

import { useRef } from "react";
import type { PointerEvent } from "react";
import type { ResizeHandleProps } from "./resize-handle-types";

export function ResizeHandle({ label, orientation = "vertical", onResizeStart, onResize, onResizeEnd }: ResizeHandleProps) {
	const startX = useRef<number | null>(null);

	function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		startX.current = orientation === "horizontal" ? event.clientY : event.clientX;
		event.currentTarget.setPointerCapture(event.pointerId);
		onResizeStart?.();
		event.preventDefault();
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
		if (startX.current === null) return;
		onResize((orientation === "horizontal" ? event.clientY : event.clientX) - startX.current);
	}

	function handlePointerEnd() {
		if (startX.current === null) return;
		startX.current = null;
		onResizeEnd?.();
	}

	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation={orientation}
			tabIndex={0}
			className={orientation === "horizontal" ? "absolute inset-x-0 bottom-0 z-20 h-2 cursor-row-resize touch-none focus-visible:bg-blue-200" : "absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize touch-none focus-visible:bg-blue-200"}
			onKeyDown={event => {
				const decrease = orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
				const increase = orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
				if (event.key !== decrease && event.key !== increase) return;
				event.preventDefault();
				onResizeStart?.();
				onResize(event.key === decrease ? -20 : 20);
				onResizeEnd?.();
			}}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerEnd}
			onPointerCancel={handlePointerEnd}
		/>
	);
}
