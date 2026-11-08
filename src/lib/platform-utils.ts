/** True on macOS and iOS, where ⌘ is the command modifier; elsewhere it is Ctrl. */
export function isApplePlatform(): boolean {
	if (typeof navigator === "undefined") return true;
	const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "";
	return /mac|iphone|ipad|ipod/i.test(platform);
}
