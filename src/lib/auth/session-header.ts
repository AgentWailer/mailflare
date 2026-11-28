/**
 * The header an installed app carries its session in. It cannot use `Authorization: Bearer`:
 * Cloudflare Access with Managed OAuth claims that header for its own access tokens and
 * refuses anything else there before the request reaches Mailflare.
 */
export const SESSION_HEADER = "X-Mailflare-Session";

/**
 * A session token the client supplied on purpose: the app's own header, or a bearer token.
 * Browsers attach neither by themselves, which is what sets them apart from the cookie.
 */
export function getExplicitSessionToken(request: Request | undefined): string | undefined {
	if (!request) return undefined;
	const own = request.headers.get(SESSION_HEADER)?.trim();
	if (own) return own;
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	return authorization.slice(7).trim() || undefined;
}
