"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
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

type Gesture = { x: number; y: number; active: boolean; id: number; width: number; threshold: number; distance: number };
type Visual = { offset: number; dragging: boolean; side: "start" | "end" | null; threshold: number };
const INTENT_DISTANCE = 10;
const initialVisual: Visual = { offset: 0, dragging: false, side: null, threshold: 96 };

// Only movement can arm an action. Pointer-up coordinates can never arm it on their own.
export function SwipeableRow({ children, startAction, endAction, disabled }: SwipeableRowProps) {
	const [visual, setVisual] = useState<Visual>(initialVisual);
	const frame = useRef(0);
	const gesture = useRef<Gesture | null>(null);
	const surface = useRef<HTMLDivElement>(null);
	const swiped = useRef(false);

	const reset = useCallback(() => {
		const current = gesture.current;
		if (!current && !frame.current) return;
		gesture.current = null;
		cancelAnimationFrame(frame.current);
		frame.current = 0;
		if (current?.active) swiped.current = true;
		setVisual(previous => ({ ...previous, offset: 0, dragging: false }));
		if (current && surface.current?.hasPointerCapture?.(current.id)) surface.current.releasePointerCapture(current.id);
	}, []);

	useEffect(() => {
		const onBlur = () => reset();
		const onVisibility = () => { if (document.hidden) reset(); };
		const onAdditionalTouch = (event: globalThis.PointerEvent) => { if (event.pointerType === "touch" && event.isPrimary === false && gesture.current) reset(); };
		window.addEventListener("blur", onBlur);
		window.addEventListener("pointerdown", onAdditionalTouch, { passive: true });
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			cancelAnimationFrame(frame.current);
			gesture.current = null;
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("pointerdown", onAdditionalTouch);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [reset]);

	function display() {
		if (frame.current) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			const current = gesture.current;
			if (!current?.active) return;
			setVisual(previous => ({ offset: current.distance, dragging: true, side: current.distance ? current.distance > 0 ? "start" : "end" : previous.side, threshold: current.threshold }));
		});
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (!gesture.current) swiped.current = false;
		if (event.pointerType === "mouse") return;
		if (gesture.current || event.isPrimary === false) { reset(); return; }
		if (disabled || (event.target as Element).closest('button,input,select,textarea,label,[contenteditable="true"],[role="button"]')) return;
		const width = event.currentTarget.getBoundingClientRect().width || 320;
		gesture.current = { x: event.clientX, y: event.clientY, active: false, id: event.pointerId, width, threshold: Math.min(144, Math.max(96, width * 0.32)), distance: 0 };
		swiped.current = false;
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		if (disabled) { reset(); return; }
		const dx = event.clientX - current.x, dy = event.clientY - current.y;
		if (!current.active) {
			if (Math.abs(dy) >= INTENT_DISTANCE && Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
			if (Math.abs(dx) < INTENT_DISTANCE || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
			current.active = true;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		// No easing or resistance while held: the foreground follows the finger pixel for pixel.
		current.distance = Math.max(-current.width, Math.min(current.width, dx));
		display();
	}

	function finish(event: PointerEvent<HTMLDivElement>) {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		const releaseDistance = event.clientX - current.x;
		const trigger = !disabled && current.active && Math.abs(current.distance) >= current.threshold
			&& Math.abs(releaseDistance) >= current.threshold && Math.sign(releaseDistance) === Math.sign(current.distance);
		const action = current.distance > 0 ? startAction : endAction;
		reset();
		if (trigger) action.onTrigger();
	}

	const { offset, dragging, side, threshold } = visual;
	const action = side === "start" ? startAction : side === "end" ? endAction : null;
	const Icon = action?.icon;
	const progress = Math.min(1, Math.abs(offset) / threshold);
	const armed = dragging && progress === 1;

	return (
		<div data-swipe-row data-swipe-ready={armed} className="relative overflow-hidden">
			{action && Icon && <div aria-hidden="true" data-swipe-backdrop style={{ opacity: offset ? 1 : 0 }} className={clsx("swipe-row-motion absolute inset-0 text-white", !dragging && "transition-opacity duration-200 ease-out motion-reduce:transition-none", action.className)}>
				<div className="absolute inset-y-0 flex items-center justify-center" style={{ width: Math.abs(offset), [side === "start" ? "left" : "right"]: 0 }}>
					<span data-swipe-indicator data-ready={armed} className="swipe-action-indicator flex h-10 w-10 shrink-0 items-center justify-center rounded-full" title={action.label}>
						<Icon data-swipe-icon className="h-6 w-6" style={{ transform: `scale(${0.35 + progress * 0.65})` }} />
					</span>
				</div>
			</div>}
			<div
				ref={surface}
				data-swipe-surface
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finish}
				onPointerCancel={reset}
				onLostPointerCapture={event => {
					// A link's implicit capture is transferred to this surface when the swipe starts.
					// Its bubbling lost-capture event must not cancel our new capture.
					if (event.target === event.currentTarget && gesture.current?.id === event.pointerId) reset();
				}}
				onContextMenu={event => { if (gesture.current?.active) event.preventDefault(); }}
				onClickCapture={event => {
					if (!swiped.current) return;
					swiped.current = false;
					event.preventDefault();
					event.stopPropagation();
				}}
				className={clsx("swipe-row-motion relative bg-white", !dragging && "transition-transform duration-200 ease-[cubic-bezier(0.2,0.9,0.2,1)] motion-reduce:transition-none")}
				style={{ transform: offset ? `translate3d(${offset}px,0,0)` : undefined, touchAction: "pan-y pinch-zoom", willChange: dragging ? "transform" : undefined, userSelect: dragging ? "none" : undefined, borderRadius: dragging ? 12 : undefined }}
			>
				{children}
			</div>
		</div>
	);
}
