# Password-protected PDF attachments

Implemented on 2026-11-03 using the existing PDF.js 6.4.299 legacy renderer and
worker. The viewer previously awaited `loading.promise` without registering
`onPassword`, so an ordinary password-protected PDF became a generic attachment
load error even though the rendering engine supports it.

## User flow and privacy

Opening a protected attachment now presents a German/English password form.
Enter or **Open PDF / PDF öffnen** continues the existing document loading task.
Incorrect passwords produce a recoverable message and a fresh input; another
attempt uses the already downloaded encrypted bytes. Spaces in passwords are
preserved. A visibility toggle helps check an entry, and Cancel closes only the
attachment viewer. Successfully unlocked documents use the existing multipage
rendering, scrolling and zoom controls.

Passwords go directly from the input to PDF.js's browser worker callback. They
are not placed in React state, requests, URLs, logs or persistent browser storage.
The field is cleared immediately on submission. Closing the viewer destroys the
document loading task/worker; reopening the same attachment requires its password
again. Download still returns the original encrypted file. No server-side
decryption, API change, database migration or additional service is required.

This supports the password-based encryption understood by PDF.js; it does not
promise support for certificate-protected PDFs, external DRM or damaged files.
The user's specific SWK Bank attachment and password were not accessed.

## Validation

`tests/browser/attachment-preview.mjs` uses the real production renderer, worker
and fonts with synthetic authenticated attachment routes. Small checked-in AES-128
and AES-256 documents are described in `tests/fixtures/pdf-password/README.md`;
CI does not generate them or install additional Python PDF dependencies.

Coverage includes password prompts, incorrect/correct entry, reuse of downloaded
bytes, multipage rendering/zoom, cancellation/reopening, switching back to a plain
PDF, and checking that fixture passwords do not enter requests or browser storage.
The existing plain PDF, image, Wallet handoff and attachment retry checks remain
in the same browser suite. This suite already runs in `npm run test:smoke` in CI.

Local validation used Node 24.19.0 and Chromium 154 against a production build.
All 793 Node tests, typecheck, ESLint, dark palette validation and real HTTP cache
checks passed. The browser suite passed at 320, 390, 744, 844 and 1440 px, plus
German 390 px and German 744 px in dark mode. It also checks empty input, repeated
wrong passwords, conceal/reveal, and cancellation in the same task as submission
before the worker replies. Password forms were visually inspected at phone,
tablet, landscape and desktop sizes.

Run browser previews sequentially because their Workers runtimes share an
inspector port:

```sh
npm run build
node tests/browser/attachment-preview.mjs
MAILFLARE_PDF_LOCALE=de VIEWPORT_WIDTH=390 node tests/browser/attachment-preview.mjs
MAILFLARE_PDF_LOCALE=de MAILFLARE_PDF_DARK=1 VIEWPORT_WIDTH=744 node tests/browser/attachment-preview.mjs
```

For the local system Chromium used during development, additionally set
`MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium`. Responsive Chromium emulation
does not establish native Safari/Home Screen or software-keyboard compatibility;
verify opening, wrong-password retry, scrolling and closing on the actual iPhone
and iPad after release.

Deploy through the existing Git/Cloudflare Builds integration. Rollback reverts
the password UI, callback wiring and translations; stored attachments and mailbox
data are unaffected, but encrypted previews will again require an external viewer.
