import { MAX_FILE_MESSAGE_SIZE, MBOX_READ_CHUNK_SIZE } from "./file-limits";

export type MboxSource = { size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } };

export type MboxRecord = { raw: Blob | null; nextOffset: number; size: number; scan?: { startsLine: boolean } };

/** Byte offsets refer to the original file, including envelope lines and mbox escaping. */
async function* fragments(file: MboxSource, offset: number, chunkSize: number, initialStartsLine = true) {
	let pending = new Uint8Array(0), pendingOffset = offset, startsLine = initialStartsLine;
	for (let position = offset; position < file.size; position += chunkSize) {
		const chunk = new Uint8Array(await file.slice(position, Math.min(position + chunkSize, file.size)).arrayBuffer());
		const bytes = new Uint8Array(pending.length + chunk.length);
		bytes.set(pending); bytes.set(chunk, pending.length);
		let start = 0;
		while (start < bytes.length) {
			const newline = bytes.indexOf(10, start);
			if (newline < 0) break;
			yield { bytes: bytes.subarray(start, newline + 1), offset: pendingOffset + start, startsLine, endsLine: true };
			startsLine = true; start = newline + 1;
		}
		// A huge unbroken body line must not fill memory either.
		if (bytes.length - start >= chunkSize) {
			yield { bytes: bytes.subarray(start), offset: pendingOffset + start, startsLine, endsLine: false };
			startsLine = false; start = bytes.length;
		}
		pendingOffset += start;
		pending = bytes.slice(start);
	}
	if (pending.length) yield { bytes: pending, offset: pendingOffset, startsLine, endsLine: true };
}

function isEnvelope(bytes: Uint8Array): boolean {
	if (bytes.length > 1024 || bytes[0] !== 70 || bytes[1] !== 114 || bytes[2] !== 111 || bytes[3] !== 109 || bytes[4] !== 32) return false;
	// RFC 4155 / Gmail Takeout envelopes. A plain "From ..." sentence in the body is not a separator.
	return /^From \S+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+.+\d{2}:\d{2}(?::\d{2})?.+\d{4}(?:\s.*)?\r?\n?$/.test(new TextDecoder("latin1").decode(bytes));
}

export async function* readMboxRecords(file: MboxSource, offset = 0, options: { chunkSize?: number; maxMessageSize?: number; scanLimit?: number; discard?: { size: number; startsLine: boolean } } = {}): AsyncGenerator<MboxRecord> {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error("Invalid MBOX resume offset");
	const maximum = options.maxMessageSize ?? MAX_FILE_MESSAGE_SIZE;
	if (options.chunkSize !== undefined && (!Number.isSafeInteger(options.chunkSize) || options.chunkSize < 1024)) throw new Error("Invalid MBOX chunk size");
	let parts: BlobPart[] = [], size = options.discard?.size ?? 0, inBody = !!options.discard, foundEnvelope = !!options.discard, discarding = !!options.discard;
	let block = new Uint8Array(64 * 1024), used = 0;
	const rawMessage = () => {
		const raw = new Blob([...parts, block.subarray(0, used)], { type: "message/rfc822" });
		// Blob owns its bytes. Release the assembly buffers before yielding: the
		// caller may now hold both this Blob and the MIME parser's ArrayBuffer.
		parts = []; block = new Uint8Array(64 * 1024); used = 0;
		return raw;
	};
	for await (const fragment of fragments(file, offset, options.chunkSize ?? MBOX_READ_CHUNK_SIZE, options.discard?.startsLine)) {
		if (fragment.startsLine && fragment.endsLine && isEnvelope(fragment.bytes)) {
			if (size) yield { raw: discarding || size > maximum ? null : rawMessage(), nextOffset: fragment.offset, size };
			parts = []; block = new Uint8Array(64 * 1024); used = 0; size = 0; inBody = false; foundEnvelope = true; discarding = false;
			continue;
		}
		// Resume the boundary scan in another queue invocation, including inside an
		// enormous unbroken line. Never mistake that continuation for a new message.
		if (options.scanLimit && fragment.offset - offset > options.scanLimit && (discarding || size > maximum)) {
			yield { raw: null, nextOffset: fragment.offset, size, scan: { startsLine: fragment.startsLine } };
			return;
		}
		// Reject arbitrary files instead of silently importing an invalid archive as one message.
		if (!foundEnvelope) {
			if (fragment.bytes.every((byte) => byte === 10 || byte === 13 || byte === 32 || byte === 9)) continue;
			throw new Error("Invalid MBOX: expected a From envelope line with sender and date");
		}
		let bytes = fragment.bytes;
		if (fragment.startsLine && inBody && bytes[0] === 62) {
			let index = 0;
			while (bytes[index] === 62) index++;
			if (bytes[index] === 70 && bytes[index + 1] === 114 && bytes[index + 2] === 111 && bytes[index + 3] === 109 && bytes[index + 4] === 32) bytes = bytes.subarray(1);
		}
		if (fragment.startsLine && fragment.endsLine && (bytes.length === 1 && bytes[0] === 10 || bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10)) inBody = true;
		size += bytes.length;
		if (!discarding && size <= maximum) {
			for (let start = 0; start < bytes.length;) {
				const count = Math.min(block.length - used, bytes.length - start);
				block.set(bytes.subarray(start, start + count), used); used += count; start += count;
				if (used === block.length) { parts.push(block); block = new Uint8Array(64 * 1024); used = 0; }
			}
		} else { parts = []; used = 0; } // Keep scanning to the next envelope, but release an oversized message immediately.
	}
	if (size) yield { raw: discarding || size > maximum ? null : rawMessage(), nextOffset: file.size, size };
}
