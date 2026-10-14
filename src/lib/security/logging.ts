/** Diagnostic categories only: errors can contain SQL values, message bodies or credentials. */
export function safeErrorCategory(error: unknown): string {
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof RangeError) return "RangeError";
	if (error instanceof SyntaxError) return "SyntaxError";
	if (error instanceof Error && error.name === "AbortError") return "AbortError";
	if (error instanceof Error && error.name === "TimeoutError") return "TimeoutError";
	return "Error";
}
