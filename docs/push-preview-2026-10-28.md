# Clearer mail push previews — 2026-10-28

Previously the title contained the subject and the body only `From …`. Notifications now use the sender name (or address) as title, followed by the subject and a readable content excerpt in the body. Empty fields are omitted; long text is capped with an ellipsis without splitting surrogate pairs. Existing snippet cleanup removes tracking links and browser-view boilerplate. HTML-only mail can supply a plain-text excerpt. This is factual text extraction, without an AI call or external document service.

The existing message eligibility query now selects only relevant fields and bounded body prefixes (16,384 text / 65,536 HTML characters), instead of materializing complete bodies. Message filtering, session/mailbox authorization, Web Push encryption, unread counts and click targets are unchanged. No migrations or new infrastructure are required.

Validation: production build, targeted ESLint and 26 tests passed using `node --test tests/push-server.test.mjs tests/push-service-worker.test.mjs tests/push-client.test.mjs`. Tests decrypt intercepted local deliveries and verify actual payload structure, clean HTML/text previews, emoji/length limits, permissions, service-worker display options and click routing. No real notifications were sent. TypeScript still reports 15 existing unrelated errors; none in changed files.

The exact number of visible lines, lock-screen preview visibility and native notification layout remain controlled by iOS. Native iPhone rendering was not tested here. The new server payload works with the existing service worker and applies to future deliveries. Deploy through the existing main-branch Cloudflare build; rollback by reverting the commit through the same pipeline.
