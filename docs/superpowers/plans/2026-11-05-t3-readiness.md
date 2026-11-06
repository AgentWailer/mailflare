# T3 development readiness implementation plan

> **For agentic workers:** Use the executing-plans workflow to complete the approved three tasks in this workspace. The user has authorized implementation and committing; no deployment is included.

**Goal:** Match the Node 24 toolchain, run the release checks, and commit the reviewed local changes.

**Architecture:** Keep the existing Cloudflare production installation and current isolated worktree. Select the toolchain per project, retain locked dependencies, and validate using synthetic local data.

**Tech stack:** Node 24, Python 3.10+, npm, Vite/Vinext, Cloudflare local runtime, Playwright.

**Spec:** The user's three approved points in this conversation and [the cloud handoff](../../t3-handoff-2026-11-05.md).

## Global constraints

- Preserve production data, resources and secrets; no push, merge or deployment.
- Preserve the lockfile's dependency versions and the existing worktree changes.
- Execute browser suites sequentially and report failures without raising performance budgets to hide them.
- Review the language selector, development-only HTTP headers, tests and continuity documentation before committing.

## Review focus

- Language selection remains usable in compact and field variants, on narrow screens and with keyboard/RTL input.
- Production HTTPS policy remains strict while local development can load HTTP assets.
- Native SQLite dependencies run under Node 24 after reinstalling them.
- Recovery tests use an isolated Python 3.10+ environment.
- New T3 worktrees select the same toolchain without inheriting production secrets.

## Tasks

- [x] Install the additional Node 24 runtime, pin `.nvmrc`, configure project setup commands and verify Node/Python/native dependencies after `npm ci`.
- [x] Run `npm run check:quality`, `npm run test:smoke`, `npm run test:performance:ci` and `npm run perf:navigation`. Keep complete logs under ignored `artifacts/quality` and investigate failures before rerunning affected gates.
- [x] Review the final diff independently, fix material findings, update the handoff and validation record, and commit the reviewed files. Verify a clean working tree and report commit IDs and actual check results.

## Validation record, 5–6 November 2026

| Check | Result | Local evidence under `artifacts/quality/` |
| --- | --- | --- |
| Node/Python/native dependencies | Node 24.22.2, npm 11.19.1, Python 3.13.18; `npm ci` and isolated recovery setup successful in session output; native SQLite and recovery runtime verified again | `toolchain.log`; recovery setup also runs in `check-quality.log` |
| `npm run check:quality` | Passed: typecheck, lint, 795 tests, production build, dark palette (85 overrides), HTTP cache checks | `check-quality.log` |
| `npm run test:smoke` | Passed all 11 suites on the final build; desktop/mobile, PDFs, auth/session, language keyboard/touch/RTL/dialog focus included | `browser-smoke.log`, `browser-smoke-summary.json`, individual suite logs |
| `npm run test:performance:ci` | Failed the existing 1,300,000-byte startup JavaScript budget; all 125 unit tests and cache checks passed; the other measured browser budgets passed | `performance-ci.log`, `performance-ci.json` |
| Unmodified baseline browser benchmark | Same startup budget failure on isolated `git archive 9d7c7d4` with identical dependencies/runtime; maximum 1,355,949 bytes versus current 1,355,850 bytes | `baseline-build.log`, `performance-baseline.log`, `performance-baseline.json` |
| `npm run perf:navigation` | Passed with 60,000 synthetic messages, grouped/ungrouped, concurrency 1/8; bounded responses, correct positions/totals | `navigation.log`, `navigation.json` |

Performance conditions: Chromium 143.0.7499.4, Node 24.22.2, 4× CPU throttle,
100 ms network latency, uncompressed production assets and synthetic private
APIs. Twelve cold/warm samples cover 390/1440 px. The desktop cold-start outlier
includes an automatically preloaded reader page; the receiving sample adds
64,167 bytes compared with its smaller startup samples. No performance budget
or application preload delay was changed. This existing issue remains open;
the full release gate must not be described as passing.

The language picker initially increased the shared UI chunk. A dedicated deferred
chunk now excludes the picker itself from inbox startup, without moving common
UI dependencies into it. The final browser suites confirm the application still
loads correctly. A separate first smoke failure in the long-label touch-drag
check was traced to asserting before an asynchronous cache update rendered; the
test now waits for the same unchanged expected order. Both standalone and full
reruns passed.

An independent read-only review checked the selector, development security
headers, tests and handoff. Its material gap was missing real browser coverage
of the new Radix selector; the added suite now covers both variants, narrow
touch input, keyboard scrolling/typeahead, locale persistence, RTL and focus in a
dialog. The handoff's stale toolchain/check statements were refreshed. Production
HTTPS behavior is covered separately; no migration or secret changes occurred.

The development environment is available for continued work. A production release
still needs the startup performance issue resolved or explicitly evaluated, plus
the existing release procedures. Physical iOS testing remains separate.

The development server was restarted on the private Tailscale interface at
`http://100.75.243.114:3001/setup`. HTTP returned 200; the running executable is
Homebrew Node 24.22.2. Actual development responses omit HTTPS upgrading/HSTS,
while production behavior remains covered by the security regression tests.

The reviewed UI/browser changes are saved in `3389f4c`; development HTTP security
headers and tests are saved separately in `61fb7d3`. Toolchain and continuity
documentation are committed with this record. All commits remain local on
`t3/view-current-browser`; no push, merge or deployment is part of this work.
