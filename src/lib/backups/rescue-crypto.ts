import { createPublicKey, createHash } from "node:crypto";

// Each packet has its own random AES key. Workers can encrypt with the public RSA key
// across independent queue invocations; the private key never reaches the server.
// MFR1 | wrapped-key length (u16 BE) | wrapped key | nonce (12) | AES-GCM ciphertext | tag (16).
export const PACKET_OVERHEAD = 4 + 2 + 384 + 12 + 16;
export const RESCUE_ALGORITHM = "RSA-OAEP-3072-SHA256+AES-256-GCM";

export function validateRescuePublicKey(value: unknown): JsonWebKey {
	if (!value || typeof value !== "object") throw new Error("A public recovery key is required");
	const key = value as JsonWebKey;
	if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string" || key.d || key.p || key.q || key.dp || key.dq || key.qi || key.oth || Buffer.from(key.n, "base64url").length !== 384 || key.e !== "AQAB") throw new Error("Use an RSA-3072 public recovery key without private material");
	const clean = { kty: "RSA", n: key.n, e: key.e };
	const parsed=createPublicKey({ key: clean, format: "jwk" });
	if(parsed.asymmetricKeyDetails?.modulusLength!==3072)throw new Error("Use an RSA-3072 public recovery key");
	return clean;
}

export const recoveryKeyFingerprint = (key: JsonWebKey) => createHash("sha256").update(JSON.stringify({ kty: key.kty, n: key.n, e: key.e })).digest("hex");

const importedKeys=new Map<string,Promise<CryptoKey>>();
export async function encryptRescuePacket(publicKey: JsonWebKey, content: Uint8Array): Promise<Uint8Array> {
	const aes = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
	let imported=importedKeys.get(publicKey.n!);
	if(!imported){if(importedKeys.size>=4)importedKeys.clear();imported=crypto.subtle.importKey("jwk",{kty:"RSA",n:publicKey.n!,e:publicKey.e!},{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);importedKeys.set(publicKey.n!,imported);}
	const wrapped = Buffer.from(await crypto.subtle.encrypt({name:"RSA-OAEP"},await imported,aes));
	const header = Buffer.alloc(6);header.write("MFR1");header.writeUInt16BE(wrapped.length,4);
	const additionalData=Buffer.concat([header,wrapped,nonce]);
	const key=await crypto.subtle.importKey("raw",aes,{name:"AES-GCM"},false,["encrypt"]);
	const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData},key,content as BufferSource);
	return Buffer.concat([additionalData,Buffer.from(encrypted)]);
}
