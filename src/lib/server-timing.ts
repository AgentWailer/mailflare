/** Request-local timings only; no mail content, identities or credentials in headers. */
export function requestTiming() {
	let start = performance.now();
	const stages: string[] = [];
	return {
		mark(name: string) {
			const now = performance.now();
			stages.push(`${name};dur=${(now - start).toFixed(1)}`);
			start = now;
		},
		headers() { return { "Server-Timing": stages.join(", ") }; },
	};
}
