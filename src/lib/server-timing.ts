/** Request-local timings only; no mail content, identities or credentials in headers. */
export function requestTiming() {
	let start = performance.now();
	const stages: string[] = [];
	return {
		async measure<T>(name: string, task: PromiseLike<T>): Promise<T> {
			const began = performance.now();
			try { return await task; }
			finally { stages.push(`${name};dur=${(performance.now() - began).toFixed(1)}`); }
		},
		mark(name: string) {
			const now = performance.now();
			stages.push(`${name};dur=${(now - start).toFixed(1)}`);
			start = now;
		},
		headers() { return { "Server-Timing": stages.join(", ") }; },
	};
}
