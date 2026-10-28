# Mail workspace redesign — 28 October 2026

The approved reference is the generated desktop/phone design sheet. This implementation updates the mailbox itself, following the earlier navigation release.

## Shipped UI

- Separate phone brand/action row and full-width search; a softer rectangular search field on desktop. The header is hidden while reading a message on phones.
- Scrollable category chips with intrinsic text widths, visible selection and retained arrow navigation.
- Comfortable message rows separate sender, subject and preview. Labels occupy their own line, rather than replacing preview text. Compact mode remains the dense list. Checkboxes align with select-all; unread dots supplement bold text and the existing read/unread surface distinction.
- Sender images are optional in quick settings; disabled by default for the reference's checkbox/dot layout. Turning them on restores the existing sender-avatar component. No new image service is used.
- Round phone compose action, consistent reader gutters and an explanatory empty reader state.
- Visual density and light/dark/system choices. Quick settings also expose category visibility, preview visibility, unread dots, sender images, 25/50/100 messages per page, language and existing desktop shortcuts.
- Existing saved reading position and size are respected. A fresh bottom-reading layout still divides available height equally; right-reading remains selectable to reproduce the reference's desktop columns.

## Implementation and constraints

Presentation preferences use a validated local browser setting with cross-tab notification and an in-memory fallback when storage is blocked. They contain no mail content. Page size is bounded to 25/50/100, resets list scope/offset, and is shared with folder/category preloading so warming requests use the same cache key as navigation. Mailbox authorization and API semantics are unchanged.

No dependencies, external fonts, storage migration or additional Cloudflare service/cost. This is a responsive implementation, not a pixel-for-pixel copy of generated image text. Real controls and existing functionality replace illustrative elements.

## Validation

Production build and local Chromium screenshots with synthetic private APIs. Reviewed 320/390/768/1024/1440 px plus dark desktop/mobile. New display controls, theme changes, right/bottom layouts, text fit, hover actions, category navigation, search, message opening, animation, and preferences were checked. Separate unit and browser suites exercise persisted settings, read-pane stability, bounded preloading, selection/drag-drop, attachments and swipe release/cancel behavior.

The TypeScript check still reports the same 15 pre-existing errors outside the changed implementation; targeted lint reports no new errors. No authenticated real-iPhone session is available here. Production confirmation checks the deployed Worker version/artifact; it is not a live end-to-end mailbox test.

Commands (run preview suites sequentially because their inspector port is shared):

```sh
npm run build
DESIGN_REVIEW=1 MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium VISUAL_OUTPUT=/tmp/mail-design node tests/browser/visual-polish.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/mail-display-settings.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/mail-search.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/category-tabs.mjs
MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/message-drag-drop.mjs
node --test tests/mail-display-options.test.mjs tests/message-density.test.mjs tests/persistent-reading-pane.test.mjs tests/mailbox-preload.test.mjs tests/pull-to-refresh.test.mjs
```

Screenshots and machine-readable results: `/workspace/reports/design-refresh-2026-10-28/`.

## Rollout / rollback

Push the tested commit to main and let the existing Cloudflare Git build publish. Verify 100% traffic and artifact markers `mail-mobile-wordmark`, `data-theme-preview`, `mailflare-display-options`, and `data-reading-message`. Revert this UI commit through the same pipeline if necessary. The optional display preference can remain in localStorage; the previous version ignores it. No database rollback is necessary.
