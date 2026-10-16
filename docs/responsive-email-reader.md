# Responsive HTML email reader

The old shadow renderer kept fixed-width tables and images at their original size inside a horizontal scroller. Reproduction with the prior renderer showed a 680px newsletter in a 296px reader at a 320px viewport. This matches the reported clipped mobile newsletter; the original private EF email was not accessed.

`fit-email-to-width.ts` measures the available reader width and the rendered content extent. Fluid emails keep their original size and long URLs may wrap. Overflowing layouts get a separate presentation canvas at the newsletter width, scaled down to fit. The surrounding viewport follows the scaled height, with no horizontal scroll surface or unscaled blank tail. It never enlarges emails. RTL overflow is measured on both sides.

The shared `EmailHtmlRenderer` applies this to single messages, expanded conversation messages and quotes. ResizeObserver and batched animation-frame updates follow reader width, intrinsic image size, quoted sections, orientation and loaded fonts. Observers/listeners disconnect when content changes or unmounts; stable messages do not keep measuring. Clickable links remain native links.

Owned layout wrappers use unpredictable element names, isolated layout defaults and presentation-only styles. The sanitized message's HTML and inline styles remain intact. Dark-mode adaptation skips the owned layout wrappers so theme restoration cannot undo a newer fit. Existing sanitization, shadow isolation and external-content authorization remain in effect; no mail, labels or attachment data is changed.

Validation:

- The production build passes. Targeted lint passes; the full TypeScript check retains the same 15 unrelated pre-existing diagnostics.
- All 20 email-HTML/security tests pass.
- `tests/browser/email-responsive.mjs` uses the real sanitized renderer with synthetic fixed-width, fluid, RTL, oversized-image, quote and overriding-style fixtures at 320, 390, 768 and 1440px. It checks resizing, late images, link hit targets, scaled height, no horizontal scrolling, normal-size fluid text, dark/light changes and no idle measurement loop.
- The existing email-theme browser suite verifies restored original message styles, contrast, quote state and external-content controls on five desktop/mobile/tablet sizes. The snapshot excludes only the owned fitting wrappers, whose height legitimately changes when a quote opens.

Browser checks emulate viewport and touch sizes in Chromium; they do not certify rendering on a physical iPhone. No live mailbox session or external email image was used.
