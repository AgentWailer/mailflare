"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type SwipeAction = {
	label: string;
	icon: LucideIcon;
	className: string;
	onTrigger: () => void;
};

type SwipeableRowProps = {
	children: ReactNode;
	// Revealed when dragging left to right.
	startAction: SwipeAction;
	// Revealed when dragging right to left.
	endAction: SwipeAction;
	disabled?: boolean;
};

const COMMIT_DISTANCE = 88;
const INTENT_DISTANCE = 10;

function resistedOffset(distance: number) {
	const magnitude = Math.abs(distance);
	return Math.sign(distance) * (magnitude <= COMMIT_DISTANCE ? magnitude
		: COMMIT_DISTANCE + 64 * (1 - Math.exp(-(magnitude - COMMIT_DISTANCE) / 90)));
}

// Touch-only swipe gestures; vertical scrolling stays with the browser via touch-action: pan-y.
export function SwipeableRow({ children, startAction, endAction, disabled }: SwipeableRowProps) {
	const [offset, setOffset] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [side, setSide] = useState<"start" | "end" | null>(null);
	const frame = useRef(0);
	const nextOffset = useRef(0);
	const gesture = useRef<{ x: number; y: number; active: boolean; id: number } | null>(null);
	const swiped = useRef(false);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	function display(distance: number) {
		nextOffset.current = distance;
		if (frame.current) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			const value = nextOffset.current;
			setOffset(value);
			if (value) setSide(value > 0 ? "start" : "end");
		});
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (disabled || event.pointerType === "mouse") return;
		gesture.current = { x: event.clientX, y: event.clientY, active: false, id: event.pointerId };
		swiped.current = false;
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.active) {
			if (Math.abs(dy) > INTENT_DISTANCE && Math.abs(dy) > Math.abs(dx)) {
				gesture.current = null;
				return;
			}
			if (Math.abs(dx) < INTENT_DISTANCE) return;
			current.active = true;
			setDragging(true);
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		display(resistedOffset(dx));
	}

	function finish(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		gesture.current = null;
		if (!current.active) return;
		swiped.current = true;
		setDragging(false);
		const dx = event.clientX - current.x;
		cancelAnimationFrame(frame.current);
		frame.current = 0;
		setOffset(0);
		if (event.type !== "pointercancel") {
			if (dx >= COMMIT_DISTANCE) startAction.onTrigger();
			else if (dx <= -COMMIT_DISTANCE) endAction.onTrigger();
		}
	}

	// Keep the backdrop mounted while the row returns, so it fades rather than flashes white.
	const action = side === "start" ? startAction : side === "end" ? endAction : null;
	const Icon = action?.icon;
	const armed = Math.abs(offset) >= COMMIT_DISTANCE;

	return (
		<div className="relative overflow-hidden">
			{action && Icon && (
				<div
					aria-hidden="true"
					style={{ opacity: Math.min(1, Math.abs(offset) / 48) }}
					className={clsx("swipe-row-motion absolute inset-0 flex items-center px-6 text-white", side === "start" ? "justify-start" : "justify-end", !dragging && "transition-opacity duration-300 ease-out motion-reduce:transition-none", action.className)}
				>
					<span className={clsx("flex items-center gap-2 text-sm font-medium transition-transform motion-reduce:transition-none", armed && "scale-110 motion-reduce:scale-100")}>
						<Icon className="h-5 w-5" />
						{action.label}
					</span>
				</div>
			)}
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={finish}
				onClickCapture={(event) => {
					if (!swiped.current) return;
					swiped.current = false;
					event.preventDefault();
					event.stopPropagation();
				}}
				className={clsx("swipe-row-motion relative bg-white", !dragging && "transition-transform duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)] motion-reduce:transition-none")}
				style={{ transform: offset ? `translate3d(${offset}px,0,0)` : undefined, touchAction: "pan-y", willChange: dragging ? "transform" : undefined }}
			>
				{children}
			</div>
		</div>
	);
}
