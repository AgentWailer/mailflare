import type { MetadataRoute } from "next";

// Use an explicit route, rather than file-based manifest metadata, so the root
// layout can emit exactly one credentialed manifest link for Cloudflare Access.
export function GET(): Response {
	const manifest: MetadataRoute.Manifest = {
		name: "Mailflare",
		short_name: "Mailflare",
		description: "Email, anywhere.",
		// Preserve the identity previously inferred from start_url.
		id: "/inbox",
		start_url: "/inbox",
		scope: "/",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#ffffff",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
		],
	};
	return Response.json(manifest, {
		headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" },
	});
}
