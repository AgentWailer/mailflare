# Category navigation response

Baseline assessed on 2026-11-02; final navigation measurements and history-race
fix verified on 2026-11-03 against `ba712fc`. Runtime versions: Vinext
`1.0.0-beta.13`, React `19.3.0`, Vite `8.3.5`, Playwright `1.57.0` and system
Chromium `154`. No Cloudflare service, database schema or cache policy changes.

## Cause and implementation

The five overview routes (`/inbox`, `/invoices`, `/promotions`, `/social`,
`/orders`) return `null` from their server pages. Their persistent client layout
already owns the category bar, list and reading pane. Nevertheless, every tab
used `router.push()`, delaying the active category and its list until an otherwise
unnecessary React Server Component (RSC) response arrived. Intent preloading
often completed the actual message request earlier than that response.

`InboxCategoryTabs` now uses the framework-supported native History API only
between these exact overview paths. `usePathname()` updates the existing client
layout immediately. Clicking also starts the existing shared, scoped list
request; a cold category displays its loading state, and a warm category uses
its existing cache. Messages from the previous category are never presented as
the new category's contents.

Readers and other destinations retain normal router navigation. Native history
does not itself cancel an outstanding router request, so the public
`instrumentation-client.ts` `onRouterTransitionStart` hook records pending
transitions. A category click during one uses the router to supersede it.
Ordinary route markers clear only when their own destination pathname commits.
Back/Forward markers survive that commit: Vinext's same-tree history restoration
can change the URL without cancelling an older reader RSC. A category-target
`popstate` therefore schedules a public `router.replace()` after the router's
synchronous history bookkeeping. This supersedes the old request even when the
user makes no further selection. The captured URL and traversal generation
prevent the recovery from overriding a newer navigation. Its same-path commit
retains the guard; the first subsequent category uses one real router request,
then later direct tab changes again use native history. Cancelling a reader by tapping
its current category also clears the opening preview. After a same-path
cancellation the marker remains conservative until the next actual route commit.
Do not clear the guard just because a link unmounts or the browser URL changes
before the new route commits.

This shortcut must not be extended to server-owned content or dynamic reader
routes. If an overview server page later gains meaningful rendering or data,
reassess this optimization. The implementation uses public
[native History integration](https://nextjs.org/docs/app/building-your-application/routing/linking-and-navigating#using-the-native-history-api)
and the [router transition instrumentation hook](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client#onroutertransitionstart),
verified against the installed Vinext implementation.

## Controlled before/after measurement

The same production-preview browser harness ran against baseline and changed
builds. It uses synthetic private mailbox APIs, a **500 ms RSC delay** and a
**350 ms list API delay**, with independent browser contexts for desktop
1440 px (bottom/right/off reader), tablet 744 px (bottom), and phone 390 px
(bottom/off). Background speculative warming is disabled through the browser's
data-saving setting. Four previously unvisited categories per context give
24 cold samples per build. Intent warming and the normal shared request cache
remain active.

The metric is **click event to committed DOM state** (active tab or matching
message rows), measured inside the page with `performance.now()` and a
`MutationObserver`. It is not INP, a paint trace, a field percentile, an iOS
device measurement, or a production API benchmark.

| Lab metric | Baseline p50 / p75 / p95 | Changed p50 / p75 / p95 |
| --- | --- | --- |
| Cold active category, 24 samples | 550.3 / 553.9 / 563.1 ms | 8.2 / 9.3 / 10.6 ms |
| Matching cold rows, 24 samples | 550.3 / 553.9 / 563.2 ms | 360.8 / 365.0 / 366.6 ms |

Cold active-category results ranged from 7.0–14.2 ms after the change versus
544.2–563.4 ms before. The direct cold overview sequence made **zero RSC
requests**. The harness separately checks the automatic Back replacement and
the single RSC needed for the first category after Back/Forward, then requires
**zero RSC or list requests** for
subsequent warm tab changes. That deliberate history recovery is excluded from
the direct-tab latency budget. Cold data still waits for its API response, as it
should. The experiment demonstrates removal of the route-response dependency,
not a promise of these timings on every device or network.
The 18 measured warm continuation selections after that recovery had p50
15.6 ms and p95 43.0 ms.

A separate run isolated a slow list API: RSC delay 0 ms, list delay
1200 ms, 744/390 px viewports, eight cold category samples. Active-category DOM
updates took 7.0–9.4 ms while the correct rows appeared after 1208.5–1220.9 ms.
No prior category's rows appeared under the new active tab. This confirms that
the UI response is independent of both route and list-response latency, while
the loading state continues to reflect outstanding data.

## Regression coverage

`tests/browser/category-tabs.mjs` runs the real production router and assets.
It checks the persistent shell, exact category data, cache reuse, first-page
and unread-filter reset, reverse-order responses during rapid selection,
reader/open/back/forward, reload and deep links. Delayed reader, sidebar and
Settings requests cannot replace a more recent category choice. Back during
a pending reader and Back followed by another category are also covered.
The history assertions synchronously capture the browser-selected target in
the `popstate` event before router processing. Vinext can commit a cached reader
shell while its RSC response remains pending; taking an earlier CDP history
snapshot and pressing Back later races that commit and can invent a wrong
expected target. A held response alone does not prove that navigation has not
committed. Late reader responses must still leave the captured target intact.
Both pending-reader/Back alone and Back/rapid-category races run at sixfold CPU slowdown;
ordinary latency measurements run without CPU throttling. A controlled test
on 2026-11-03 reproduced both the outdated CDP expectation and a genuinely late
reader overwriting a newer native category after Back. CI subsequently exposed
the same outstanding reader replacing Back's destination even without another
selection. Capturing `popstate` fixes the test expectation; the public router
replacement and preserved traversal guard cover the two actual stale-response
paths.
Uncached history traversal after leaving the category layout remains outside
this focused regression suite; the verified race uses the existing same-tree
category/reader history.

The existing scoped-cache/persistent-pane/preload Node suites also passed
30 tests, including late category/account responses and stale cache isolation.
The production build's typecheck, lint and full test suite passed separately.

The standalone viewport suite now waits for the responsive sidebar state and
finite layout transitions after rotation before taking its scroll baseline.
The previous fixed 300 ms pause could sample the 200 ms grid transition while
it was still running after asynchronous breakpoint updates. Scroll assertions
retain their one-pixel tolerance; no production header or viewport CSS changed.

The browser test additionally supports real emulated touch events (`hasTouch`
and `tap`) and a horizontal touch swipe when the category strip overflows.
Touch timings start at touch pointer-down. This is Chromium touch emulation,
not native Safari, iPadOS or a Home Screen installation.

The final build passed separate 744/390 px touch runs with the actual German
labels. Eight cold activations measured 9.0–14.5 ms from touch pointer-down;
the six warm continuation activations after history recovery were 16.1–18.9 ms.
The 390 px strip scrolled with a horizontal
touch swipe without selecting a different category; at 744 px all tabs fit.

## Reproduce and CI

Run preview suites sequentially: local Workers previews share an inspector port.
Use the installed Playwright browser, or set
`MAILFLARE_CHROMIUM_EXECUTABLE=/usr/bin/chromium` for the system browser used here.

```sh
npm run build
node tests/browser/category-tabs.mjs
MAILFLARE_CATEGORY_TOUCH=1 MAILFLARE_CATEGORY_CASES=744:bottom,390:bottom node tests/browser/category-tabs.mjs
MAILFLARE_CATEGORY_RSC_MS=0 MAILFLARE_CATEGORY_API_MS=1200 MAILFLARE_CATEGORY_CASES=744:bottom,390:bottom node tests/browser/category-tabs.mjs
node --test --test-concurrency=2 tests/mail-list-refresh.test.mjs tests/persistent-reading-pane.test.mjs tests/mailbox-preload.test.mjs
```

For a baseline comparison, build `ba712fc` in a separate checkout and run a copy
of the current harness with `MAILFLARE_CATEGORY_BASELINE=1`. That mode records
the same initial timing samples while omitting assertions for the new fast path.
The default checks require cold active-category feedback below 200 ms despite
the delayed RSC/API, zero overview RSC requests and zero warm list requests.

`.github/workflows/performance.yml` runs the six default cases and the separate
744/390 px touch cases, retaining their combined JSON-line measurement log at
`artifacts/performance/category-tabs.log`. A bounded failure excerpt is also
published in CI annotations. These narrow regression budgets complement the existing performance
checks; they do not establish Core Web Vitals compliance.

## Release and rollback

Deploy the reviewed commit through `main` and the existing Cloudflare Builds
integration; do not deploy this release directly with Wrangler. No migration,
new service or extra paid infrastructure is needed. Verify first cold and then repeated category
changes on the actual iPhone/iPad Home Screen app, including sideways scrolling,
reader/back and a slow network. Keep synthetic delay tests on preview/CI only.

Rollback is a normal source revert and rebuild of the four navigation files
(`inbox-category-tabs.tsx`, `message-category-layout.tsx`,
`pending-mail-navigation.ts`, `instrumentation-client.ts`). It restores the
previous router path without changing stored mail or settings. Keep the
measurement harness for comparison; use baseline mode when deliberately
testing the slower rollback behavior.
