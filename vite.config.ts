import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const pdfPackage = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");

export default defineConfig({
	resolve: {
		// css-tree's ESM build loads ../data/patch.json through createRequire, which workerd cannot resolve; the dist bundle inlines it.
		alias: [{ find: /^css-tree$/, replacement: "css-tree/dist/csstree.esm" }],
	},
	server: { allowedHosts: ["mailflare.local", "mail.dev"] },
	plugins: [
		{
			name: "pdf-preview-resources",
			applyToEnvironment: environment => environment.name === "client",
			async generateBundle() {
				const { version } = JSON.parse(await readFile(pdfPackage, "utf8"));
				// Self-host fonts/decoders. Versioned paths match the immutable asset policy.
				for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
					for (const file of await readdir(join(dirname(pdfPackage), directory))) {
						this.emitFile({ type: "asset", fileName: `_next/static/pdfjs-${version}/${directory}/${file}`, source: await readFile(join(dirname(pdfPackage), directory, file)) });
					}
				}
			},
		},
		vinext({ images: { optimizer: imagesOptimizer() } }),
		cloudflare({
			remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === "true",
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
	],
});
