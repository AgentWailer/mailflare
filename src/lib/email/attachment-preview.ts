import { getMimeEssence } from "@/lib/http/content-type";
/** Shared by the viewer and authenticated download route. Never infer active documents. */
const filenameTypes: Record<string, string> = {
	pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
	png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
	bmp: "image/bmp", ico: "image/x-icon",
	mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
	mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
	txt: "text/plain", csv: "text/csv", json: "application/json", xml: "application/xml",
};
const aliases: Record<string, string> = {
	"application/x-pdf": "application/pdf", "application/acrobat": "application/pdf",
	"applications/vnd.pdf": "application/pdf", "text/pdf": "application/pdf",
	"text/x-pdf": "application/pdf", "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg",
	"image/x-png": "image/png", "audio/x-wav": "audio/wav",
};
const genericTypes = new Set(["", "application/octet-stream", "binary/octet-stream",
	"application/binary", "application/x-binary", "application/unknown", "application/download",
	"application/force-download", "application/x-download", "application/x-octet-stream"]);

export function resolveAttachmentContentType(contentType: string, filename?: string): string {
	// Never turn ambiguous MIME metadata into a permitted type by dropping parameters.
	if (contentType && !getMimeEssence(contentType)) return "application/octet-stream";
	const normalized = getMimeEssence(contentType) ?? "";
	const type = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
	const extension = filename?.trim().toLowerCase().split(".").pop() ?? "";
	// Some senders label binary files as plain text. Only known passive formats
	// may override this; explicit HTML, SVG and other active MIME types stay blocked.
	if (genericTypes.has(type) || type === "text/plain") return Object.hasOwn(filenameTypes, extension) ? filenameTypes[extension] : (type || "application/octet-stream");
	return type;
}

export function attachmentPreviewKind(contentType: string, filename?: string) {
	const type = resolveAttachmentContentType(contentType, filename);
	if (type === "application/pdf") return "pdf";
	if (type.startsWith("audio/")) return "audio";
	if (type.startsWith("video/")) return "video";
	if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
	if (["text/plain", "application/json", "application/xml", "text/csv"].includes(type)) return "text";
	return "unsupported";
}
