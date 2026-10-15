import type { BackupExportPlan } from "./stream";

export type RescueChunk = { key: string; sha256: string; bytes: number; rawBytes: number };
export type RescueRelation = { table: string; columns: string[]; target: string; targetColumns: string[] };
export type RescueObject = {
	backup_id: string; source_key: string; source_etag: string; size: number; blob_key: string;
	destination_etag: string | null; metadata: string; checksums: string; state: string; checkpoint: string | null;
};
export type RescueObjectCopy = { uploadId: string; parts: R2UploadedPart[]; hashes: string[]; offset: number; verify: number; uploaded: boolean };
export type RescueCheckpoint = {
	version: 2; phase: "database" | "inventory" | "objects" | "manifest" | "publish" | "cleanup";
	plan: BackupExportPlan; cursor: { table: number; after: number | null; pageRows?:number }; publicKey: JsonWebKey; keyFingerprint: string;
	parts: RescueChunk[]; inventoryCursor?: string; manifestAfter: string | null; shards: RescueChunk[];
	objectCount: number; objectBytes: number; objectCipherBytes: number; storedBytes: number; failures: number;
	schema: { type: string; name: string; sql: string }[]; migrations: Record<string, string | number | null>[];
	relations: RescueRelation[];
};
export type RescueManifest = {
	format: "mailflare-rescue"; version: 1; backupId: string; createdAt: string; verifiedAt: string;
	database: { format: "mailflare-rescue-table"; version: 1; parts: RescueChunk[]; tables: string[]; schema: {type:string;name:string;sql:string}[]; migrations: Record<string, string | number | null>[] };
	objects: { count: number; bytes: number; shards: RescueChunk[] };
	scope: "database-and-live-objects"; sourceBucket: string; backupBucket: string;
	keyFingerprint: string;
};
