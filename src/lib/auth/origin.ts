import { getExplicitSessionToken } from "./session-header";

/** Call only after session authentication. Bearer tokens are not sent automatically by browsers. */
export function hasValidSessionMutationOrigin(request: Request): boolean {
	// A token the client put there itself; a page on another site cannot make a browser send one.
	if (getExplicitSessionToken(request)) return true;
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
	const origin = request.headers.get("Origin");
	return origin !== null ? origin === new URL(request.url).origin : fetchSite === "same-origin";
}
