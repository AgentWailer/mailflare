import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encryptRescuePacket } from "./rescue-crypto";
import type { DatabaseBackupTable, DatabaseRecord } from "./types";
import type { RescueChunk } from "./rescue-types";

export const RESCUE_PREFIX = "rescue";
export const CURRENT_RESCUE_KEY = `${RESCUE_PREFIX}/current.json`;
export const COPY_BYTES = 8 * 1024 * 1024;
export const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const snapshotPrefix = (id: string) => `${RESCUE_PREFIX}/snapshots/${id}/`;
export const objectBlobKey = (key: string, etag: string, fingerprint: string) => `${RESCUE_PREFIX}/objects/${hashBytes(`${key}\0${etag}\0${fingerprint}`)}`;

export function referencedObjectKeys(table: DatabaseBackupTable, row: DatabaseRecord): string[] {
	const column = table === "messages" ? "raw_r2_key"
		: table === "message_attachments" || (table === "drive_items" && !row.upload_id) ? "r2_key"
		: table === "users" || table === "domains" || table === "contacts" ? "avatar_key"
		: table === "app_settings" ? "icon_key" : null;
	return column && typeof row[column] === "string" && row[column] ? [row[column] as string] : [];
}

/** Read back every new compressed chunk before it can be included in a published manifest. */
export async function putVerifiedChunk(bucket: R2Bucket, key: string, raw: Uint8Array, publicKey: JsonWebKey): Promise<RescueChunk> {
	const compressed = await encryptRescuePacket(publicKey, gzipSync(raw));
	const sha256 = hashBytes(compressed);
	await bucket.put(key, compressed, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { sha256 } });
	const read = await bucket.get(key);
	if (!read) throw new Error("Rescue chunk missing after upload");
	const bytes = new Uint8Array(await read.arrayBuffer());
	if (bytes.byteLength !== compressed.byteLength || hashBytes(bytes) !== sha256) throw new Error("Rescue chunk checksum mismatch");
	return { key, sha256, bytes: bytes.byteLength, rawBytes: raw.byteLength };
}

export async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const object = await bucket.get(key);
	return object ? JSON.parse(await object.text()) as T : null;
}
