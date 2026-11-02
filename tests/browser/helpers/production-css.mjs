import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Use the root layout's actual build assets, never a lazy feature stylesheet. */
export function readProductionCss(root = process.cwd()) {
 const client = resolve(root, 'dist/client');
 const manifestPath = join(root, 'dist/server/__vite_rsc_assets_manifest.js');
 if (existsSync(manifestPath)) {
  const source = readFileSync(manifestPath, 'utf8').trim();
  let manifest;
  try { manifest = JSON.parse(source.replace(/^export default\s+/, '').replace(/;$/, '')); }
  catch (cause) { throw new Error(`Cannot read the production CSS manifest at ${manifestPath}; rebuild the application.`, { cause }); }
  const styles = manifest.serverResources?.['src/app/layout.tsx']?.css;
  if (Array.isArray(styles) && styles.length) {
   return Buffer.concat(styles.map(asset => {
    const file = resolve(client, '.' + new URL(asset, 'https://fixture.invalid').pathname);
    if (!file.startsWith(client + sep) || !file.endsWith('.css')) throw new Error(`Invalid root-layout CSS asset: ${asset}`);
    if (!existsSync(file)) throw new Error(`Production root-layout CSS is missing: ${file}; rebuild the application.`);
    return Buffer.concat([readFileSync(file), Buffer.from('\n')]);
   }));
  }
 }
 // Older Vinext builds did not emit root-layout resources. Accept only one
 // recognizable main stylesheet and fail rather than pick stale/feature CSS.
 const directory = join(client, '_next/static/css');
 if (!existsSync(directory)) throw new Error(`Production CSS is missing at ${directory}; run npm run build first.`);
 const names = readdirSync(directory).filter(name => /^(?:index|worker-entry)[.-][^.]+\.css$/.test(name));
 if (names.length !== 1) throw new Error(`Expected one production main stylesheet in ${directory}, found ${names.length}: ${names.join(', ') || '(none)'}. Rebuild the application.`);
 return readFileSync(join(directory, names[0]));
}
