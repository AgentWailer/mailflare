/** Browser caching is explicit for private images; personalized app responses never enter shared caches. */
export function applyAppCachePolicy(request: Request, response: Response): Response {
	const path = new URL(request.url).pathname;
	if (path.startsWith('/_next/static/')) return response;
	const type = response.headers.get('Content-Type') ?? '';
	const page = type.includes('text/html') || type.includes('text/x-component') || ['/', '/login', '/setup'].includes(path);
	const apiWithoutPolicy = path.startsWith('/api/') && !response.headers.has('Cache-Control');
	if (!page && !apiWithoutPolicy) return response;
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'private, no-store');
	return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
