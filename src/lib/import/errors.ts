/** Invalid source messages can be set aside; storage/database outages must be retried. */
export class ImportMessageError extends Error {
 constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ImportMessageError"; }
}

export function importErrorMessage(error: unknown) {
 if (error instanceof ImportMessageError) return error.message.slice(0, 350);
 let cause = error;
 for (let depth = 0; depth < 4 && cause instanceof Error && cause.cause instanceof Error; depth++) cause = cause.cause;
 return cause instanceof Error && !cause.message.startsWith("Failed query:")
  ? cause.message.slice(0, 350) : "Database write failed; resume to retry. Query values are hidden.";
}

export function isInvalidImportMessage(error: unknown) {
 return error instanceof ImportMessageError || /SQLITE_TOOBIG|string or blob too big|(?:row|value|body|statement|bound parameter).{0,80}(?:too large|too big|exceeds|size limit)/i.test(importErrorMessage(error));
}

export function isTransientImportError(error: unknown) {
 return /network|connection|timeout|timed out|temporary|temporarily|storage failed|\b(?:429|500|502|503|504)\b|overload|rate limit|SQLITE_BUSY|database is locked/i.test(importErrorMessage(error));
}
