export const WALLET_PASS_CONTENT_TYPE = "application/vnd.apple.pkpass";

/** Imported mail may label a pass as a ZIP or a generic binary attachment. */
export function isWalletPass(contentType: string, filename?: string): boolean {
	return contentType.split(";", 1)[0].trim().toLowerCase() === WALLET_PASS_CONTENT_TYPE
		|| /\.pkpass$/i.test(filename ?? "");
}
