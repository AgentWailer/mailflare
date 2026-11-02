// Build-time guard: adding a Tailwind palette utility must not lose its dark theme.
// Reads only local build artifacts, including lazy styles and literal JS color variables.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const families = 'neutral|gray|stone|zinc|slate|blue|red|green|amber|sky|violet|teal|pink|orange|rose|yellow|indigo|purple|lime|cyan|emerald';
const paletteColor = new RegExp(`^--color-(?:white|black|(?:${families})-\\d+)$`);
const source = readFileSync('src/app/globals.css', 'utf8');
const dark = source.match(/^\.dark \{([\s\S]*?)^\}/m)?.[1];
assert(dark, 'The global dark palette must be present');
const overrides = new Set([...dark.matchAll(/(--color-[\w-]+)\s*:/g)].map(match => match[1]));
const references = new Map();
let stylesheets = 0;
for (const name of readdirSync('dist/client', { recursive: true })) {
 if (!/\.(css|js)$/.test(name)) continue;
 const css = name.endsWith('.css');
 if (css) stylesheets++;
 const text = readFileSync(join('dist/client', name), 'utf8');
 const expression = css ? /var\(\s*(--color-[\w-]+)/g : /(--color-[\w-]+)/g;
 for (const match of text.matchAll(expression)) {
  if (paletteColor.test(match[1]) && !overrides.has(match[1])) references.set(match[1], name);
 }
}
assert(stylesheets > 0, 'No production stylesheets found; build the application first');
assert.equal(references.size, 0, `Used colors need explicit dark overrides in globals.css:\n${[...references].map(([color, file]) => `${color} (${file})`).join('\n')}`);
console.log(`Dark palette coverage verified across ${stylesheets} production stylesheets and client JavaScript (${overrides.size} overrides).`);
