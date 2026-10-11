# Mail UI quality check — 2026-10-11

## Compact reader header

Subject and assigned labels share a wrapping row. Smaller article and sender gaps
bring the body closer to the header. Summary and translation are icon buttons beside
the date, label action and star, with translated accessible names and tooltips; their
separate action row is removed. The disclosure next to the recipient opens the full
envelope, including Cc/Bcc and full date. Phones use a shorter visible date. Touch
targets remain at least 44 px while desktop icon buttons use 32 px.

The production build passed. A Chromium check of the actual message detail page
passed at 320, 390, 820, 1024 and 1440 px in both themes: no page overflow, a single
icon-only AI group, correct summary/translation handoff, accessible envelope details
and usable touch targets. Screenshots were inspected at desktop and phone sizes.
Focused component ESLint passed; the page retains its existing state-in-effect lint
error, and TypeScript retains the same 17 pre-existing diagnostics. Native Safari
keyboard and Home Screen verification remain outside this Chromium check.
The existing reading-pane Chromium suite also passed its composer, reply, layout,
initial-preview, assistant handoff and refresh/retry scenarios.

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

## Unread consistency and initial desktop preview (2026-10-11)

Marking a message read now reconciles mailbox counters, including quiet reader
updates and changes from another browser tab. Stale counter requests cannot replace
newer state; returning to the app also refreshes counts. The reader navigation shows
the message's chronological position rather than a historical unread count. A
production D1 audit found zero unread inbox messages when the old UI displayed seven.

On desktop screens of at least 1024 px, an enabled reading pane automatically opens
the first message of the current list. This respects mailbox, search, unread filter,
pagination and conversation settings, and shares the list's cached request. Navigation
replaces the empty preview history entry. Existing selections survive refresh and
new arrivals; empty or failed lists retain their overview. Phones and smaller tablets
start with the list, and drafts and disabled reading panes do not auto-open messages.
The effect rechecks the saved layout before navigation, preventing a hydration race
from opening a message when the stored preference is off.

The production build and focused ESLint passed. All 22 selected function tests passed
(eight preview, eight read-sync and six refresh cases). The Chromium reading-pane
suite passed eight composer layouts, five real floating-reply flows, eight reader/list
layouts, four initial-preview scenarios, assistant handoff, legacy disabled-layout
preservation and three refresh/retry scenarios. Desktop category changes retain the
preview without HTML document reloads. Reply fixtures now return valid account and
identity responses instead of draft responses for unrelated authentication routes.
Type checking retains the same 17 pre-existing diagnostics.

Firefox/WebKit binaries remain unavailable: runtime network policy revision 4 does
not include the two Playwright download hosts saved in the configuration draft.
Applying that draft is still required before downloading those engines. Chromium
viewport and keyboard simulations do not certify physical iPhone/iPad Safari or
Home Screen status-bar behavior; those device checks remain outstanding.

```sh
node --test tests/initial-message-preview.test.mjs tests/message-read-sync.test.mjs tests/mail-list-refresh.test.mjs
node tests/browser/reading-pane.mjs
```

## Unread counter and reader navigation consistency

A read-only production aggregate check on 2026-10-11 found zero unread primary
inbox messages while the screenshot still displayed seven. Quiet read actions
updated list/detail caches but did not reconcile counts. The reader separately
retained its initial unread snapshot and explicitly kept opened messages unread,
so its `0 of 7 unread` label was neither a current count nor a valid position.

Successful read/unread cache updates now invalidate counts and notify all count
consumers, including other browser tabs. Counter requests are invalidated before
the refresh debounce, preventing late responses from restoring old values.
Focus, page restoration and visibility changes reconcile server state; mailbox
snapshots and optimistic deltas stay scoped to their mailbox. Reader arrows now
follow the chronological list and display a message position (`12 of 29`).
Navigation membership refreshes on message/count changes and app restoration.

All seven original targeted regressions failed against the previous source and
passed with the fix; an additional tab-forwarding test passed. The combined
read-sync, list-refresh and account-switch suites passed 19 tests. Seven selected
SQLite-backed inbox, label, navigation/access and JMAP checks also passed. The
production build and focused ESLint passed; type checking retains the same 17
existing diagnostics. The Chromium reading-pane suite passed its composer,
reply, layout and manual-refresh scenarios on a diagnostic rerun after an
initial intermittent timeout opening the profile source link. Native iOS and
the previously unavailable Firefox/WebKit engines were not validated here.

```sh
node --test tests/message-read-sync.test.mjs tests/mail-list-refresh.test.mjs tests/account-switch.test.mjs
node --test --test-name-pattern='all incoming mail|conversation rows|multiple labels|authorization|JMAP reads|primary membership' tests/smart-inbox.test.mjs
node tests/browser/reading-pane.mjs
```

## Dark message presentation and footer removal (2026-10-11)

HTML message colors now follow the selected app theme inside the existing sanitized
shadow renderer. Bright surfaces become dark, neutral text becomes light, links
retain a readable color, and borders remain visible. Already dark surfaces and
saturated buttons are preserved when suitable. Text contrast is checked against
the effective background; a red button with black text stays readable. Pure CSS
gradients are normalized, while photos and remote background images are not
inverted. Transparent logos retain their original canvas. Images containing baked-in
text remain images. Unusual sender designs can use the per-message Original colors
control. This changes presentation only, without AI requests or stored-mail changes.

Theme toggles preserve the current shadow tree, expanded quotes and remote-content
permission. Returning to light mode restores the original inline style attributes
exactly. Transparent text remains transparent. Original-color and remote-content
controls, plus quote expanders, have 44 px touch targets on small/coarse screens.

The persistent source/license footer is hidden in application views. The full source
offer is available in the profile menu and remains visible on public/authentication
pages. Compose popups no longer have an internal source footer; readers use the full
viewport, the floating compose button retains its bottom touch gap, and safe-area
padding remains. This supersedes the earlier internal-footer layout described above.

Theme changes also persist a non-secret resolved-color cookie. Server-rendered HTML
and Apple status-bar metadata use that value before client JavaScript runs on the
next app launch. Local production-preview requests with light and dark cookies both
returned 200 and the correct initial HTML class and Apple metadata. iOS may keep the
previous native status-bar style until the Home Screen app fully restarts; dynamic
metadata alone does not guarantee a live native color change.

The production build and focused ESLint checks passed. The same 17 pre-existing
TypeScript diagnostics remain. All 33 selected sanitizer, refine-editor and compose
network tests passed. The new Chromium theme script passed at 320, 390, 768, 820 and
1440 px, including repeated light/dark/original-color toggles, contrast, important
sender styles, legacy table backgrounds, image preservation, exact restoration,
quote state, remote permissions and switching messages. The full reading-pane script
passed again with eight compose layouts, five actual reply flows, eight reader/list
layouts and three refresh scenarios. It verifies that the footer is hidden, the
source offer is reachable in the profile menu, and Send/AI remain reachable.

Firefox/WebKit remain unrun: their binaries are absent, and the required download
hosts are still absent from the running network policy. Both host additions are
confirmed saved in the environment configuration draft. Reusable QA startup
instructions were also saved. Saving the draft does not apply/publish it. The user
must save/apply and publish the environment changes before the blocked browser
installation can be retried. Native iPhone/iPad verification remains outstanding.

```sh
node --test tests/email-html.test.mjs tests/refine-editor.test.mjs tests/compose-network-errors.test.mjs
node tests/browser/email-theme.mjs
node tests/browser/reading-pane.mjs
```

Viewport emulation and synthetic `visualViewport` events do not reproduce native
iOS keyboard or Home Screen status-bar behavior. On iOS, changing status-bar metadata
may take effect only after closing and reopening the installed app. A physical
iPhone check remains necessary for that behavior; no live native-style change is
guaranteed by these tests.

## Follow-up: sidebar and personal label visibility

All twelve mail areas now remain listed, including empty scheduled mail, drafts,
archive, spam and trash. The sidebar no longer truncates labels to three or uses
More/Less controls. Existing saved ordering is retained. The sidebar scrolls when
the complete list exceeds the screen height.

Settings → Inbox → Label visibility controls each label in the selected mailbox.
The preference belongs to the signed-in user, syncs through the server across
devices, and affects only the sidebar. Mail labels and rule/label menus remain
available. Read-only delegates may change their own display. Updates edit one ID
atomically to retain concurrent changes, and refetch on focus/reconnect picks up
another device's changes.

Migration `0063_label_visibility.sql` adds a default-empty JSON column to `users`.
It must be applied before deploying the new schema because session queries select
the user columns. No table is added or removed; existing backup table/group/type
lists already include `users`. Real SQLite tests verify preservation in backups
and restoration of older backups to the all-visible default.
The existing Cloudflare installation applied and verified this migration before
the GitHub-triggered deployment on 2026-10-11.

The follow-up build passed. All 75 selected function tests passed, including five
new authenticated API/database cases and two delayed-response account-switch
cases. A response from the previous account cannot refill the preference cache,
including when switching accounts while its JSON body is still loading.
Both delayed-response tests fail against the preceding implementation and pass
with the additional guard.
Chromium checks were rerun for composing,
reply/forward drafts, full-page/popup/modal editors, reading layouts, category
navigation, refresh/retry and menus. Label ordering/deletion passed at five sizes.
The new visibility check passed at six phone/tablet/desktop sizes, including dark
mode, long names, all labels hidden/re-enabled, saved-state reload, mailbox changes,
pending-write protection, HTTP failure/retry and label creation preserving input
after a failed request. Lint passes for the follow-up application files; the 17
pre-existing TypeScript diagnostics remain unchanged.

Firefox/WebKit and physical iOS checks remain unrun for the reasons above. The
new visibility and existing label-action browser scripts also accept
`MAILFLARE_BROWSER=firefox` or `MAILFLARE_BROWSER=webkit` once those engines are
installed. No actual external email was sent during these checks.

## Follow-up: nested labels

Labels now have an optional parent in the same mailbox. Existing labels remain
at the top level. The sidebar displays expandable groups, remembers expansion
locally per mailbox, and keeps ordering separate for each group of siblings.
Creating a sublabel expands its ancestors so the new label is immediately visible.
Settings → Inbox → Labels controls both personal visibility and parent assignment.
Readonly delegates retain their personal visibility controls but cannot change the
shared hierarchy. Label names retain their existing mailbox-wide uniqueness.

Hidden parents do not implicitly hide their visible children. Deleting a parent
promotes its immediate children to the top level; descendants, messages, attachments
and the children's label assignments remain. Message label/move menus include the
full label path. Failed metadata refreshes retain the last loaded labels.

Migration `0064_nested_labels.sql` adds `folders.parent_id`, a self-reference with
`ON DELETE SET NULL`, an index, and database guards for mailbox boundaries and
cycles. Atomic guards reject concurrent reciprocal moves. There are no new tables;
the existing backup table/group/type lists already include `folders`. Restore inserts
all labels before restoring their parent relationships, so backup row order does
not matter. Older backups remain restorable. A nested backup presented to an older
schema is rejected before existing data is deleted.

The production build passed. All 82 selected function tests passed, including seven
new hierarchy/access/deletion/backup cases and the existing compose/refine/refresh/
account-scope/visibility tests. The existing Chromium compose/reader/refresh, message
menus, flat-label actions and visibility scripts were rerun successfully. The new
nested-label script passed at 320, 390, 768, 820, 1024 and 1440 px, including dark
mode, expansion across reloads, sibling ordering, creating a child of a collapsed
parent, moving labels, retry after failed moves, excluding descendants from parent
choices, readonly controls, keeping visible children of hidden parents, deleting a
parent, last-label hit testing and no horizontal overflow. Touch group/menu controls
have 44 px targets. Actual application components are used with controlled API
responses; these remain Chromium tests rather than physical device certification.

ESLint passes for the new hierarchy/API/settings/sidebar application files. The
pre-existing state-in-effect error in `ReorderableList` and unused-argument warning
in the backup module remain. Type checking still reports the same 17 pre-existing
diagnostics. Firefox/WebKit and native iOS limitations described above remain.

Run the additional checks with:

```sh
node --test tests/nested-labels.test.mjs tests/label-visibility.test.mjs tests/label-visibility-client.test.mjs
node tests/browser/nested-labels.mjs
node tests/browser/label-visibility.mjs
node tests/browser/label-actions.mjs
```

## Inline filter labels and mobile reply (2026-10-11)

Filters now offer an inline "New label" action, including optional parent selection.
Creating a label selects it alongside previously selected labels without closing the
filter or resetting its criteria. Enter creates the label rather than submitting
the filter. Pending creation blocks filter submission; failed and duplicate-name
requests preserve the entered name and allow retry. Readonly delegates do not get
the creation control. No database migration is needed.

The iPhone reader now has a labelled Reply button in the top action bar. The
read/unread action remains in the additional-actions menu. Reply uses the existing
draft, recipient and conversation logic. Touch popups cover the full visual
viewport, with an opaque backdrop and their source offer inside the editor, below
the action bar. Background elements become inert and page scrolling is locked
while the popup is open. Editor and portal-menu scrolling remains available;
minimizing or closing restores the background and its original scroll position.

The production build passed, as did 50 selected filter, hierarchy, compose-network
and refine function tests. The filter test includes actual label creation and
subsequent routing through the SQLite-backed API. The new Chromium filter script
passed at 320, 390, 768, 820 and 1440 px, covering retries, duplicate names, pending
submission, automatic selection, nested paths, cancellation and readonly access.
The reading-pane script covers eight editor layouts, five actual floating-reply
flows, eight reader/list layouts and three manual-refresh cases. Reply checks
include a simulated 360 px visual viewport, recipient preservation, background
wheel/touch prevention, scrolling inside the draft and portal menu, reachable
Send/AI/source controls, and minimize/restore/close. Existing message-menu checks
also passed at eight viewport sizes. These tests do not send production emails.

Focused ESLint passed for the new hook, creator, filter utility/dialog and changed
template components. Broader checks still encounter existing compose state-in-effect
errors, its translation dependency warning, the schedule Date.now purity error
and the reply callback memoization error. Type checking retains the same 17
pre-existing diagnostics. Chromium simulation does not certify the native iPhone
keyboard or Safari Home Screen behavior; physical-device verification and the
previously blocked Firefox/WebKit runs remain outstanding.

```sh
node --test tests/message-filters.test.mjs tests/nested-labels.test.mjs tests/compose-network-errors.test.mjs tests/refine-ui.test.mjs tests/refine-editor.test.mjs tests/refine-api.test.mjs
node tests/browser/rule-label-creation.mjs
node tests/browser/reading-pane.mjs
node tests/browser/message-action-menus.mjs
```
