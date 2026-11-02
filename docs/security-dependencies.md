# Dependency review — 2 November 2026

The quality-audit refresh updates DOMPurify to 3.4.17, MCP server SDK to 2.4.0,
Next/its ESLint configuration to 16.4.4, Nodemailer to 10.3.1, SMTP server to
3.21.3, Vite to 8.3.5, Wrangler to 4.156.1 and the Cloudflare Vite plugin to
1.67.0. The vulnerable Undici pin was removed; current compatible transitive
versions are 7.30.1 and 8.12.3. Brace expansion and URI parser patch releases
were refreshed without changing their major-version contracts.

Verification at this date:

- `npm audit --omit=dev --json`: **zero reported vulnerabilities**.
- Full `npm audit --json`: **zero critical/high**, 16 moderate package entries
  inherited through the ESLint/TypeScript ESLint toolchain's minimatch branches.
- The remaining advisory is GHSA-g3hv-75wg-m249 (globparts amplification,
  https://github.com/advisories/GHSA-g3hv-75wg-m249). These are build/lint tools,
  not code serving mail or processing request-supplied patterns in the Worker.

Do not force minimatch 11 into consumers expecting minimatch 3's callable
CommonJS export, or accept npm's suggested downgrade to old ESLint/Next config.
Those are not compatible security fixes. The bounded CI timeout limits stalled
jobs; review PR filenames/configuration and do not execute untrusted repository
changes with production credentials. Review this temporary development-only
exception again by **2 December 2026**, or when upstream tooling releases a
compatible patch. A newly reported production vulnerability or high/critical
advisory is not covered by this exception.

Re-run the registry audit before upgrades, then `npm run check:quality`, browser
smoke and performance checks. No application security guarantee follows merely
from an empty dependency report; custom authorization, storage and send-integrity
regressions remain necessary.
