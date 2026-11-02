import { readArrayBufferBody } from "@/lib/http/request";

// MCP carries commands and text, not binary attachment uploads. Bound both the
// transport bytes and JSON shape before handing authenticated input to the SDK.
export const MCP_REQUEST_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

export class McpJsonShapeError extends Error {}

export async function boundedMcpRequest(request: Request): Promise<Request> {
	if (request.method !== "POST") return request;
	const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (mediaType !== "application/json") throw new McpJsonShapeError("Expected application/json");
	const bytes = await readArrayBufferBody(request, MCP_REQUEST_BYTES);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const entry = pending.pop()!;
		if (++nodes > MAX_NODES || entry.depth > MAX_DEPTH) throw new McpJsonShapeError("JSON is too complex");
		if (entry.value !== null && typeof entry.value === "object") {
			for (const child of Object.values(entry.value)) {
				if (pending.length + nodes >= MAX_NODES) throw new McpJsonShapeError("JSON is too complex");
				pending.push({ value: child, depth: entry.depth + 1 });
			}
		}
	}
	const headers = new Headers(request.headers);
	headers.delete("Content-Length");
	return new Request(request.url, { method: "POST", headers, body: text, signal: request.signal });
}
