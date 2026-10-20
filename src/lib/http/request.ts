import { RequestBodyTooLargeError } from "./errors";

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
	return consumeBody(request, maxBytes, async response => {
		const text = await response.text();
		return text ? JSON.parse(text) as T : {} as T;
	});
}

export function assertRequestSize(request: Request, maxBytes: number): void {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > maxBytes) {
		void request.body?.cancel().catch(() => {});
		throw new RequestBodyTooLargeError("Request body is too large");
	}
}

export async function readFormDataBody(request: Request, maxBytes: number): Promise<FormData> {
	return consumeBody(request, maxBytes, response => response.formData());
}

export async function readArrayBufferBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
	return consumeBody(request, maxBytes, response => response.arrayBuffer());
}

/** Count bytes before buffering/decoding, even without an honest Content-Length.
 * Multipart parsing consumes the stream directly instead of retaining a second
 * full request ArrayBuffer alongside the parsed files.
 */
async function consumeBody<T>(request: Request, maxBytes: number, consume: (response: Response) => Promise<T>): Promise<T> {
	assertRequestSize(request, maxBytes);
	const reader = request.body?.getReader();
	let bytes = 0, exceeded = false;
	const body = reader ? new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const part = await reader.read();
				if (part.done) { controller.close(); return; }
				bytes += part.value.byteLength;
				if (bytes > maxBytes) {
					exceeded = true;
					void reader.cancel().catch(() => {});
					controller.error(new RequestBodyTooLargeError("Request body is too large"));
					return;
				}
				controller.enqueue(part.value);
			} catch (error) { controller.error(error); }
		},
		cancel(reason) { return reader.cancel(reason); },
	}, { highWaterMark: 0 }) : null;
	try { return await consume(new Response(body, { headers: request.headers })); }
	catch (error) {
		// Some multipart runtimes wrap the stream error in a parser TypeError.
		if (exceeded) throw new RequestBodyTooLargeError("Request body is too large");
		throw error;
	} finally { void reader?.cancel().catch(() => {}); }
}
