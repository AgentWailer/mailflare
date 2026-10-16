# Message density and quick settings

The gear in the mail header opens quick settings. On desktop (1024px and wider), these sit beside the mailbox so the current message remains usable. Smaller screens use a bottom sheet with a scrollable body, reachable close button and link to full settings. Theme, reading layout and density take effect immediately.

There are two densities: Comfortable (the default) and Compact. Desktop compact rows are approximately 29px high and omit sender avatars; comfortable rows are 44px. Touch devices retain suitable targets and mobile rows keep sender, subject and preview text in both modes. Unread messages have a white background with bold text; read messages have a light gray background. Selection remains blue, and dark mode uses corresponding dark surfaces.

Density is stored per browser in `mailflare-message-density`, like the existing reading-layout preference. Open tabs synchronize changes; blocked browser storage still allows changes for the current session. No mailbox/API operation is needed to change the view. The quick-settings component loads only when opened.

A bottom reading pane starts at half the available height, including when an older browser has a fixed `message-list-height` preference. Subsequent manual resizing is saved as `message-list-ratio`, including its existing user-specific key, so the chosen proportion survives viewport changes. The right-side reading pane keeps its separate width preference. Phones continue to show a full-screen list or message.

Validation uses the production build/router with synthetic private API responses, without accessing live mail: `tests/browser/mail-display-settings.mjs` checks desktop, 390px and 320px layouts, both densities, persistence, colors, retained list DOM, no overflow, 50/50 resizing with the viewport, focus restoration, dark surfaces and bottom-sheet geometry. `tests/message-density.test.mjs` covers synchronized consumers, other tabs and unavailable storage. Persistent-reader unit tests cover the new default and saved ratio, and the existing reading-pane browser test covers drag resizing and stored proportions. These are browser emulations, not certification on a physical iPhone.

On 2026-10-16 the production build and 94 targeted unit/regression checks passed, as did the display-settings, reading-pane and cold-start browser suites. Targeted lint passed. The full TypeScript check still reports the 15 pre-existing diagnostics in unrelated admin/calendar/settings/API files; it reports none in the changed display components.
