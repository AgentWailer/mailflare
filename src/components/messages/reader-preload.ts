let reader: Promise<void> | undefined;

/** Public reader code only: importing never renders it or fetches message bodies. */
export function preloadMessageReader(): Promise<void> {
	if (typeof window === "undefined") return Promise.resolve();
	if (!reader) reader = import("@/app/(dashboard)/inbox/[messageId]/page").then(() => undefined).catch(error => {
		reader = undefined;
		throw error;
	});
	return reader;
}
