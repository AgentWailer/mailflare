import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { OutputOptions } from "rolldown";

const pdfPackage = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");

function workerSidecarOutput(output: OutputOptions = {}, assetsDir = "_next/static"): OutputOptions {
	const fallback = output.chunkFileNames;
	const workerModule = resolve("worker.ts").replaceAll("\\", "/");
	return {
		...output,
		chunkFileNames(chunk) {
			// Vinext beta.13 emits these sidecars at the server root and imports
			// them as ./ filenames. Rolldown may extract our Worker into a shared
			// worker-entry chunk; keep that chunk beside its manifests, as Vinext
			// already does for its router-stage chunks. Other chunks keep their path.
			if (chunk.name === "worker-entry" || chunk.moduleIds.some(id => id.split("?", 1)[0].replaceAll("\\", "/") === workerModule)) return "[name]-[hash].js";
			return typeof fallback === "function" ? fallback(chunk) : fallback ?? `${assetsDir}/[name]-[hash].js`;
		},
	};
}

export default defineConfig({
	resolve: {
		// css-tree's ESM build loads ../data/patch.json through createRequire, which workerd cannot resolve; the dist bundle inlines it.
		alias: [{ find: /^css-tree$/, replacement: "css-tree/dist/csstree.esm" }],
	},
	server: { allowedHosts: ["mailflare.local", "mail.dev"] },
	plugins: [
		{
			name: "worker-sidecar-path-compatibility",
			configEnvironment(name, config) {
				if (name !== "rsc") return;
				const output = config.build?.rolldownOptions?.output;
				return { build: { rolldownOptions: { output: Array.isArray(output)
					? output.map(item => workerSidecarOutput(item, config.build?.assetsDir))
					: workerSidecarOutput(output, config.build?.assetsDir) } } };
			},
		},
		{
			name: "client-ui-chunks",
			configEnvironment(name) {
				if (name !== "client") return;
				// Share small UI dependencies across routes instead of fetching a
				// separate module for each icon/hook. Editors and PDFs stay lazy.
				return { build: { rolldownOptions: { output: { codeSplitting: { groups: [
					{ name: "ui-primitives", test: /node_modules[\\/](?:@radix-ui[\\/]|lucide-react[\\/]|react-remove-scroll|react-style-singleton|use-sidecar|use-callback-ref|aria-hidden)/, priority: 20 },
				] } } } } };
			},
		},
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
			// Isolated local integration tests must never reuse a developer's D1/R2 state.
			persistState: process.env.MAILFLARE_LOCAL_STATE_PATH ? { path: process.env.MAILFLARE_LOCAL_STATE_PATH } : true,
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
	],
});
