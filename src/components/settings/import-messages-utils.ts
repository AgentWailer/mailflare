import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { getAuthHeaders } from "@/lib/auth/client";
import type { ImportMessagesResult, ImportProgressHandler } from "./import-messages-types";
import { MAX_IMPORT_REQUEST_SIZE } from "@/lib/import/file-limits";

export async function importMessageFiles(
	mailboxId: string,
	files: File[],
	destination: string,
	onProgress?: ImportProgressHandler,
): Promise<ImportMessagesResult> {
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_REQUEST_SIZE - 64 * 1024) {
		throw new Error("This archive exceeds the 25 MiB browser upload limit. Upload it directly to R2 and use the background MBOX import in Settings → Import.");
	}
	const form = new FormData();
	form.set("mailboxId", mailboxId);
	form.set("destination", destination);
	for (const file of files) {
		form.append("files", file);
	}

	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", "/api/import/messages");
		getAuthHeaders().forEach((value, key) => request.setRequestHeader(key, value));
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 70));
		};
		request.onerror = () => reject(new Error("Import upload failed"));
		request.onload = () => {
			let data: ImportMessagesResult;
			try { data = JSON.parse(request.responseText || "{}") as ImportMessagesResult; }
			catch { reject(new Error(`Import server returned HTTP ${request.status}. Use the background R2 import for large archives.`)); return; }
			if (request.status < 200 || request.status >= 300) {
				reject(new Error(data.error ?? "Import failed"));
				return;
			}
			onProgress?.(100);
			resolve(data);
		};
		request.send(form);
	});
}

export function getImportSummary(result: ImportMessagesResult | null, t: Translator = defaultTranslator): string {
	if (!result) return "";
	return t("import.summary", { imported: result.imported ?? 0, skipped: result.skipped ?? 0 });
}
