# Mailbox visual review — 28 October 2026

## Scope and evidence

Local production build served by Vite/Cloudflare preview, with the real routes, React components and CSS. All private API responses were synthetic; no production mail was accessed or changed. Chromium at 320, 390, 768, 1024 and 1440 CSS pixels; dark mode additionally at 390, 1024 and 1440. This is browser emulation, not a physical iPhone/Safari verification. Component fixtures separately cover the composer and settings.

An imagegen layout exploration informed the comparison of narrow list layouts. Generated mockups are design references, **not** implementation screenshots or test evidence. Actual screenshots were inspected before changes and after two correction rounds. No image assets or new dependencies were added to the application.

## Observed issues and implemented changes

| Priority | Observed issue | Change and tradeoff | Regression check |
| --- | --- | --- | --- |
| High | At 1024px with quick settings open, label chips overlapped the subject and timestamp; almost no subject text remained. | Below a 620px **list container** width, sender/date and subject use two rows. Labels shrink safely, move after the subject, and show one label plus a count. Full-width compact rows remain compact. Narrow rows are taller and omit the inline snippet; their subject remains readable. | Long sender, subject and two labels; subject at least 110px wide in tested desktop layouts, no label/subject overlap, labels inside their container. |
| High | On 320px phones, a nonempty search plus header controls could leave the input with zero width. | Focused search expands across the header, with a back control; filter/clear controls appear while editing. Closing preserves the query and restores settings/profile access. | Enter text, close, reopen and clear at both phone widths; advanced search and spam selection regression suite. |
| Medium | In right-hand reading layout, the narrow-list CSS hid the unread filter even when the toolbar contained only a folder title. | Keep the filter visible in this layout; preserve the existing space handling when the bulk toolbar is present. | Cold category test toggles unread, paginates, then navigates through all categories in right-hand layout. |
| Medium | Long German category labels wrapped or were partially clipped; later categories lacked an obvious mouse navigation control. | Single-line scrolling strip with previous/next controls only on overflow. The active category is revealed on navigation. Motion respects reduced-motion preference. | Scroll arrows, select last category, browser Back, active tab fully visible; existing cold tab/navigation tests. |
| Medium | At the smallest phone width, folder name and pagination competed for the same horizontal space. | At widths below 375px, pagination takes its own line. This costs one control row of height but retains the full folder name and reachable controls. | Toolbar must not overlap the category strip. |
| Low | Hover actions used a separate fixed color patch, especially noticeable in dark mode. | Actions use the row's theme-aware hover/selection colors. | Light/dark screenshots and hit-testing each hover action. |
| Low | Empty reading pane placed a lone sentence near its top edge. | Vertically centered, quiet mail icon and status text. No image download or animation added. | Existing half-height pane behavior retained; screenshot review. |
| Low | “Scheduled” remained English in the German sidebar. | German label “Geplant”. | German screenshots. |

The existing compose layout, direct AI Polish/undo behavior, settings hierarchy and mobile reading view were retained after inspection. The goal was to fix observed collisions and improve hierarchy, not to replace working UI.

## Reproduce

```sh
npm run build
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  VISUAL_OUTPUT=/tmp/mailflare-visual npm run test:visual
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/mail-display-settings.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/category-tabs.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/mail-search.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/compose-window.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/settings-sections.mjs
node --test tests/message-density.test.mjs tests/persistent-reading-pane.test.mjs
```

Use your installed Chromium path or omit `MAILFLARE_CHROMIUM_EXECUTABLE` with Playwright browsers installed. Run preview suites sequentially: simultaneous workerd previews compete for inspector port 9229.

Artifacts for this run: `/workspace/reports/mailflare-visual-2026-10-28/` contains before/after screenshots and representative composer/settings controls. Files there use fictional messages only.

## Completed validation

- Production build: passed.
- 70 browser scenarios: 8 visual viewport/theme combinations; 4 density/quick-settings cases; 5 category/reading-layout cases; 15 cross-folder search cases; 7 composer/keyboard/AI-undo cases; 31 settings/navigation/deep-link cases.
- 13 unit/component tests: passed (message density and persistent reading pane).
- Final screenshots reviewed with vision, including desktop/narrow desktop, 320px/390px phones, tablet, dark mode, hover, reader, composer and settings.
- `git diff --check`: passed.

## Validation limitations

No real email delivery, authentication provider, server-side search correctness or physical mobile keyboard was tested by this visual suite. Composer tests exercise simulated keyboard viewport changes. No performance or accessibility conformance claim is made.

Repository-wide TypeScript checking has the same 15 pre-existing errors as the pre-change baseline, none in the changed components. Targeted linting of modified UI files identifies five existing `set-state-in-effect` errors in the message list/split-layout; comparison with `HEAD` confirms these precede this change. Other changed UI components pass lint. No suppression was added.

No Cloudflare binding, storage schema, cache policy, billing setting or backend behavior changed. Rollback consists of reverting these UI/test changes and rebuilding; no data migration is involved.
