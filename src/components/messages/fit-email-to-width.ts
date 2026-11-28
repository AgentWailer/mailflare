/** Fit only the presentation surface. The sanitized message and its inline styles stay intact. */
/** Below this scale a message is too small to read on a phone. */
const UNREADABLE_SCALE = 0.6;
/** Letting words break is kept only when it wins back at least this much scale. */
const WORTHWHILE_GAIN = 0.15;
const RELAXED = "data-email-relaxed";

/**
 * The rule the fallback below switches on. Words normally stay whole (see `long-tokens.ts`); a
 * message that would otherwise be shown too small to read (many narrow columns, a long string spread
 * over several styled pieces) may break its words anywhere instead, which was the rule for every
 * message before. Broken words read badly, text a third of its size does not read at all.
 */
export function relaxedWrapStyle(rootTag: string): string {
	return `[${RELAXED}] ${rootTag}, [${RELAXED}] ${rootTag} * { overflow-wrap:anywhere; }`;
}

export function fitEmailToWidth(host: HTMLElement, viewport: HTMLElement, canvas: HTMLElement) {
	const set = (element: HTMLElement, name: string, value: string) => element.style.setProperty(name, value, "important");
	const layoutStyle = document.createElement("style");
	layoutStyle.textContent = `${viewport.localName}, ${canvas.localName} { all:initial!important; display:flow-root!important; box-sizing:border-box!important; margin:0!important; padding:0!important; border:0!important; -webkit-text-size-adjust:100%!important; text-size-adjust:100%!important; }`;
	host.shadowRoot?.insertBefore(layoutStyle, viewport);
	for (const element of [viewport, canvas]) element.dataset.emailLayout = "";
	set(viewport, "direction", "ltr");
	set(viewport, "width", "100%");
	set(viewport, "overflow", "hidden");
	set(canvas, "direction", host.dir || "ltr");
	set(canvas, "transform-origin", "0 0");
	let frame = 0;
	let stopped = false;
	let observedWidth = -1;
	function extent() {
		let left = 0, right = Math.max(canvas.clientWidth, canvas.scrollWidth);
		// scrollWidth misses left-side overflow in RTL and centred fixed-width layouts.
		if (right > canvas.clientWidth + 1 || host.dir === "rtl") {
			const origin = canvas.getBoundingClientRect().left;
			for (const element of canvas.querySelectorAll("*")) {
				const bounds = element.getBoundingClientRect();
				if (!bounds.width || !bounds.height) continue;
				left = Math.min(left, bounds.left - origin);
				right = Math.max(right, bounds.right - origin);
			}
		}
		return { left, width: Math.ceil(right - left) };
	}
	function layout(available: number) {
		set(canvas, "transform", "none");
		set(canvas, "width", `${available}px`);
		let bounds = extent();
		if (bounds.width > available + 1) {
			// Let percentage-based descendants lay out inside the newsletter's actual width.
			set(canvas, "width", `${bounds.width}px`);
			bounds = extent();
		}
		return bounds;
	}
	function measure() {
		frame = 0;
		if (stopped || !host.isConnected || host.clientWidth <= 0) return;
		const available = host.clientWidth;
		// Each width is judged afresh: a wider reader may not need what a phone needed.
		canvas.removeAttribute(RELAXED);
		let bounds = layout(available);
		const whole = available / Math.max(1, bounds.width);
		if (whole < UNREADABLE_SCALE) {
			canvas.setAttribute(RELAXED, "");
			const relaxed = layout(available);
			// A message of fixed width (a newsletter) gains nothing from broken words: it keeps them whole.
			if (available / Math.max(1, relaxed.width) >= whole + WORTHWHILE_GAIN) bounds = relaxed;
			else { canvas.removeAttribute(RELAXED); bounds = layout(available); }
		}
		const scale = Math.min(1, available / Math.max(1, bounds.width));
		const height = Math.max(canvas.scrollHeight, canvas.getBoundingClientRect().height);
		set(canvas, "transform", `scale(${scale}) translateX(${-bounds.left}px)`);
		set(viewport, "height", `${Math.ceil(height * scale)}px`);
		host.dataset.emailScale = String(scale);
	}
	function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(measure); }
	const observer = new ResizeObserver(entries => {
		for (const entry of entries) {
			if (entry.target === host) {
				if (entry.contentRect.width === observedWidth) continue;
				observedWidth = entry.contentRect.width;
			}
			schedule();
		}
	});
	observer.observe(host);
	observer.observe(canvas);
	host.shadowRoot?.addEventListener("load", schedule, true);
	host.shadowRoot?.addEventListener("toggle", schedule, true);
	window.addEventListener("resize", schedule);
	document.fonts?.addEventListener("loadingdone", schedule);
	// Initial fitting runs before the next paint; image loads and quote expansion remeasure later.
	measure();
	return () => {
		stopped = true;
		cancelAnimationFrame(frame);
		observer.disconnect();
		host.shadowRoot?.removeEventListener("load", schedule, true);
		host.shadowRoot?.removeEventListener("toggle", schedule, true);
		window.removeEventListener("resize", schedule);
		document.fonts?.removeEventListener("loadingdone", schedule);
		layoutStyle.remove();
	};
}
