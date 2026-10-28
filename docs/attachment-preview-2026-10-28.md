# Attachment preview repair — 2026-10-28

## Cause and scope

The mail viewer recognized PDFs only with the exact `application/pdf` MIME string. The authenticated file route had a separate, equally strict check. Generic imported MIME types, case differences, MIME parameters and PDF aliases could therefore reject valid attachments or serve the wrong type. This code path was reproduced with synthetic attachments; the user's specific debt-collection email was not opened.

A shared resolver now normalizes MIME metadata and uses an allowlisted filename extension for generic or plain-text declarations. This also applies to existing attachments without rewriting stored mail. PDF, JPEG, PNG, GIF, WebP, AVIF and common media/text extensions are covered. Explicit active HTML/SVG types are not promoted to previews. Unknown files remain downloadable for opening in a compatible app.

Image/audio/video failures now offer retry and a visible download action. PDF failures additionally offer opening separately. Empty text files finish loading. PDF rendering remains lazy, browser-local, full-width and multi-page; no files are sent to external document viewers. Authentication, mailbox authorization, private/no-store responses, nosniff and sandbox headers remain in place.

## Verification

- 17 route, metadata, Wallet and security tests passed, including generic MIME, aliases, parameters, download headers, wrong-owner/expired-session access and unsafe-file exclusions.
- Chromium production-build browser tests passed at 320×700, 390×844, 844×390 and 1440×900. Tested three-page PDFs (portrait, landscape, rotated), actual canvas edge pixels, full mobile viewport, fit-to-width/zoom, PNG/JPEG/GIF/WebP decoding, image retry, PDF retry and Wallet handoff boundary. Synthetic APIs and files; no real mail changed.
- Production build and targeted ESLint passed. TypeScript still reports the 15 existing errors outside changed files.
- Real iOS Safari and Android hardware are not available in this environment. Mobile viewport tests do not establish universal device/codec support. Office documents, HEIC/TIFF and other browser-dependent formats may require download and a local app; no promise of universal inline rendering.

## Reproduction

```sh
node --test tests/wallet-attachments.test.mjs tests/app-security-regressions.test.mjs
npm run build
node tests/browser/attachment-preview.mjs
```

For a system browser, set `MAILFLARE_CHROMIUM_EXECUTABLE`; an external Playwright installation can be selected with `MAILFLARE_PLAYWRIGHT_MODULE`.

## Rollout and rollback

Use the established push-to-main Cloudflare build. Verify the deployed worker contains the shared MIME normalization. No migrations, new bindings, external services or additional service fees. Roll back by reverting this commit through the same build pipeline; stored attachment bytes and metadata are unchanged.
