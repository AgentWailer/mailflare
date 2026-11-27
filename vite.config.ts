import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { OutputOptions } from "rolldown";
import { catalogScriptPath, catalogScriptSource, catalogVersion, DEFAULT_CATALOG, readCatalogs } from "./scripts/locale-catalog-scripts.mjs";

const pdfPackage = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");

// Interface catalogues, shipped by a build as scripts of their own (see scripts/locale-catalog-scripts.mjs).
const catalogs = readCatalogs(import.meta.dirname);
const catalogsVersion = catalogVersion(catalogs);
const englishModule = resolve("src/lib/i18n/english.ts").replaceAll("\\", "/");
const englishClientModule = resolve("src/lib/i18n/english-client.ts");

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
					// The language picker is used by deferred settings/auth screens, not inbox startup.
					{ name: "language-select", test: /node_modules[\\/]+@radix-ui[\\/]+react-select[\\/]/, priority: 30, includeDependenciesRecursively: false },
					{ name: "ui-primitives", test: /node_modules[\\/](?:@radix-ui[\\/]|lucide-react[\\/]|react-remove-scroll|react-style-singleton|use-sidecar|use-callback-ref|aria-hidden)/, priority: 20 },
				] } } } } };
			},
		},
		{
			// Tells application code that this build has catalogue scripts, and under which version.
			// Development keeps the catalogue in the page, so a changed text shows without a rebuild.
			name: "locale-catalog-version",
			apply: "build",
			config: () => ({ define: { __MAILFLARE_CATALOG_VERSION__: JSON.stringify(catalogsVersion) } }),
		},
		{
			// One script per language under the immutable static path; the browser bundle reads English
			// from those instead of carrying it (about 150 kB) in the startup script for every language.
			name: "locale-catalog-scripts",
			apply: "build",
			applyToEnvironment: environment => environment.name === "client",
			async load(id) {
				if (id.split("?", 1)[0].replaceAll("\\", "/") !== englishModule) return null;
				return readFile(englishClientModule, "utf8");
			},
			generateBundle() {
				const english = catalogs.get(DEFAULT_CATALOG);
				for (const [code, catalog] of catalogs) {
					this.emitFile({ type: "asset", fileName: `_next/static/${catalogScriptPath(catalogsVersion, code)}`, source: catalogScriptSource(code, catalog, english) });
				}
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
