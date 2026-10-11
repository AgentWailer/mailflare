# Mail UI quality check — 2026-10-11

This check covers the actual mail UI components with controlled API responses and
a local routing fixture. It does not authenticate against the production mailbox
or send real mail. The routing fixture verifies client navigation and state changes;
it does not validate the production framework's authenticated routing end to end.

## Changes

- Category tabs navigate with the client router and warm the selected mailbox's
  category data. Cached lists appear immediately when returning to a category.
- Manual refresh bypasses the HTTP and client caches, refreshes sidebar counts,
  keeps visible messages while loading, and provides a retryable error message.
  Late responses cannot replace another mailbox or category's current list.
- A failed sidebar prefetch still opens the requested folder.
- Touch composers use the visible viewport, including keyboard height and offset.
  The full-page editor removes its extra heading and padding on touch devices.
  Send, AI and header controls have 44 px touch targets; touch menus do too.

## Executed checks

| Check | Result |
| --- | --- |
| Production build (`npm run build`) | Passed |
| Compose network failures, refine UI/editor/API, list refresh tests | 38 passed |
| Account switching, alias selection, mailbox identity scope | 30 passed |
| Chromium composer cases | 8 passed: phone/tablet popup, reply and forward drafts, phone/tablet full-page editor, desktop popup reply and full-page editor |
| Chromium list/reader layouts | 8 sizes passed, from 320 px phone through 1440 px desktop, including tablet and landscape |
| Chromium actual refresh hook | 3 sizes passed, including pending requests, HTTP 503 and recovery |
| Chromium message menus | 8 sizes passed, including scroll reachability, focus, dismissal and dialogs |
| Chromium labels, account administration, sorting feedback | 5, 4 and 4 sizes passed respectively |

Reader checks include returning to the list, bottom/right/disabled reading layouts,
resizing, multiple selection preserving the last preview, pagination, category
switches without a new HTML document request, readable labels and sender avatars.
Composer checks include hit-testing the action buttons above the source footer,
starting/cancelling AI refinement, simulated keyboard resize, minimising/restoring
and desktop modal expansion/Escape. Theme checks cover the existing bootstrap,
document backgrounds, `color-scheme` and theme/status-bar metadata.

Type checking still reports the same 17 pre-existing diagnostics. ESLint passes
for the new refresh/cache/navigation-tab/viewport code and compose page. Existing
state-in-effect diagnostics remain in the counts hook and sidebar navigation;
the existing compose form and folder page also have previously recorded lint issues.

## Browser limits and repeatability

Only Chromium executed here. Firefox and WebKit binaries are absent, and their
downloads returned a network-policy denial. A saved environment draft adds
`cdn.playwright.dev` and `playwright.download.prss.microsoft.com`; it needs review,
saving and publication in environment settings. That draft does not change the
running machine. After access is applied, install the matching Playwright browsers
and rerun the reading-pane and message-action-menus scripts with
`MAILFLARE_BROWSER=firefox` and `MAILFLARE_BROWSER=webkit`.

Use the repository's built CSS and the installed Playwright module:

```sh
source /workspace/cloudflare-agent-tools/activate.sh
npm run build
export MAILFLARE_PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright/index.mjs
export MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium
node tests/browser/reading-pane.mjs
node tests/browser/message-action-menus.mjs
```

Viewport emulation and synthetic `visualViewport` events do not reproduce native
iOS keyboard or Home Screen status-bar behavior. On iOS, changing status-bar metadata
may take effect only after closing and reopening the installed app. A physical
iPhone check remains necessary for that behavior; no live native-style change is
guaranteed by these tests.
