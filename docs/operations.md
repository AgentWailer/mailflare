# Operating the AgentWailer Mailflare fork

Current operating guide, reviewed 2 November 2026. Use this page for an existing
Cloudflare installation. Dated investigations and `AGENTIC.md` are historical
context, not alternative release or recovery instructions.

## Source and runtime

- Application source: **https://github.com/AgentWailer/mailflare**, reviewed `main`.
  The original [hieunc229/mailflare](https://github.com/hieunc229/mailflare) is
  upstream for selective maintenance; deploying it directly omits this fork's
  changes. Preserve its copyright and the AGPL source offer.
- Cloudflare uses Vite/Vinext and `worker.ts`, not a persistent Node server.
  Workers Static Assets deliver the versioned client assets; the Worker handles
  application/API routes, incoming mail, queues, cron and realtime upgrades.
- `DB` is D1. `BUCKET` holds private live objects; `RESCUE_BUCKET` is the separate
  private R2 rescue destination. Queues persist asynchronous work; `REALTIME` is
  the per-user Durable Object binding. Workers AI, Images, Email and rate-limit
  bindings are declared in `wrangler.jsonc`. Do not assume their quotas or
  credentials merely because a binding is present.
- `mailflare`, `CF_EMAIL_WORKER_NAME` and `WORKER_SELF_REFERENCE` must agree.
  Preserve the existing bindings, routes, secrets and compatibility settings.
  Node/Docker is a separate supported runtime described in [self-hosting.md](self-hosting.md).

## New installation

Use the fork's [deployment guide](deployment.md) and verify the repository shown
by the Deploy to Cloudflare button. Provision the resources declared by the
selected configuration, including `mailflare-failed` and the private rescue
bucket. Keep runtime `CF_TOKEN` separate from the deployment token. Supply secret
values through protected inputs, never through a chat, source file or command
argument.

`/setup` initializes a **new empty** database through the bundled migration
runner and creates the first administrator. It is not a recovery or reset tool
for a populated installation. Keep the original installation intact when
recovering data to replacement resources.

## Release an existing installation

1. **Identify the target.** Record the current Git commit and active Cloudflare
   Worker version, confirm the account/database/bucket bindings and the candidate
   commit. Verify an available D1 Time Travel point and a usable rescue key/copy.
   A successful Git push alone does not prove the new Worker is active.
2. **Validate the candidate from the locked dependencies.**

   ```sh
   npm ci
   npm run check:quality
   npm run test:smoke
   ```

   `check:quality` bundles migrations, checks TypeScript and lint, runs the full
   ordinary test suite, builds the Worker, and starts it locally to verify real
   HTTP responses and cache headers. This catches runtime module-resolution
   failures that a successful bundling step alone would miss. `test:smoke` runs focused browser
   journeys against that build, sequentially. Fixtures are synthetic and do not
   authorize sending real mail. Keep the performance CI checks as well.
   `npm run build` itself runs the static checks before Vite, so the standard
   Cloudflare build command also gates the bundle. Dashboard build/deploy command
   configuration still needs independent verification; the available API token
   cannot read the Cloudflare Builds trigger configuration.
3. **Review migration compatibility before publishing.** Compare new files in
   `drizzle/migrations` with the currently deployed revision. Never edit an
   applied migration. Apply backward-compatible additive changes before code
   that requires them: for example, 0083 adds `messages.reply_to`, and 0084 adds
   `messages.header_metadata`. A code-only release with no pending migrations
   needs no D1 change.

   ```sh
   npx wrangler d1 migrations list DB --remote
   npm run db:migrate:remote
   npx wrangler d1 migrations list DB --remote
   ```

   Run these only after checking the concrete target `database_id`; skip the
   apply command when nothing is pending. The current application must remain
   usable while the additive migration runs. Destructive schema changes need
   their own staged compatibility plan. The Admin migration action is not a
   substitute when newly deployed code already depends on an absent column.
4. **Publish through the existing release path.** This installation uses the
   reviewed fork's Git/Cloudflare integration. Confirm its build/deploy commands
   run the quality gate, and verify required GitHub checks/branch protection in
   their dashboards; a workflow file alone does not enforce those external
   settings. `npm run deploy` is the gated manual deployment entry point; the lower-level
   `deploy:worker` and `upload` scripts also run the gate. Do not bypass them with
   raw `wrangler deploy` for routine releases.
5. **Verify the active deployment.** Check that the expected version receives
   100% traffic and that the response/build corresponds to the candidate commit.
   Reload and test login, inbox, an unopened message, a PDF and a saved draft on
   desktop and mobile. Check list/detail errors and background-job state. Any
   actual delivery or integration test needs an intentionally chosen test target.
   Distinguish SQL timings, server response times and visible browser latency.
6. **Rollback code safely if needed.** Revert the application commit through the
   same release path, or use the previously verified Worker version with its
   matching assets. Retain compatible nullable columns and migration history.
   Do not roll back the entire mailbox database to undo an application release.
   Recheck private cache policy and affected tasks after rollback.

## Backup and recovery

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
protects recent database history; it does not recover deleted R2 objects. The
[encrypted rescue copy](rescue-backup.md) includes referenced files in a separate
private R2 bucket and keeps the previous verified point until its replacement is
complete. The private recovery key/password stay outside the Worker. The cron
checks the configured interval; it is not proof of a daily full export.

For a disaster recovery:

1. Download, decrypt and validate the rescue copy locally with
   `scripts/recover-rescue.py`; require the `VERIFIED` result.
2. Import with `scripts/restore-rescue-to-cloudflare.py` into **new empty D1 and R2
   resources**. Verify contents, counts and references before switching bindings.
3. Preserve the current resources until the restored installation is checked.
   Restore configuration/secrets separately; data backups do not contain them.
4. Re-enable paused imports, AI, Paperless, OAuth grants and other automation only
   after reviewing their restored state and current permissions.

The Cloudflare legacy JSON restore endpoint returns `410 rescue_restore_required`
after authentication, before reading an upload or changing the database. It is
not a supported route for overwriting a live mailbox. The small Node-only legacy
import remains separate; see [legacy export notes](database-backups.md).

## Connect ChatGPT and other MCP clients

For ChatGPT, use [Cloudflare Managed OAuth](mcp-cloudflare-oauth.md). Access is the
OAuth authorization server. Mailflare verifies the signed Access identity and a
separately approved local account/key grant. An Access login alone does not grant
mailbox access. Choose OAuth in the client's actual connection controls; pasting
an MCP URL into a chat does not install a connection.

Compatible local clients can use dedicated scoped Bearer keys. Keep keys out of
prompts and URLs. Read/draft MCP tools do not require an AI model. Sending requires
a review request and explicit confirmation in Mailflare; calendar writes use
separate scopes and take effect immediately. The older [custom GPT Action](chatgpt-mailflare.md)
is an optional, distinct integration with different confirmation semantics, not
the default OAuth setup.

Browser sessions use the existing HttpOnly cookie. An existing valid cookie
continues working after the browser-storage migration; the app removes legacy
`mailflare-session-token` values and stores only a random, nonsecret cache scope
under `mailflare-session-scope`. That scope is not an API credential. Browser
requests no longer attach a session Bearer token, and logout is confirmed only
after the server revokes or switches the cookie session. Native/API Bearer
authentication is unchanged. Compatible authentication responses can still
contain a token, which the browser discards; this change reduces persistent
credential exposure and does not make arbitrary injected scripts safe.

## Routine maintenance and incident diagnosis

- Review [upstream reports](upstream-maintenance.md). The weekly watcher has read-only
  permissions: it reports candidates, never merges, upgrades packages, migrates
  or deploys. Review/adapt upstream changes into this fork and use the release
  procedure above. Do not enable the original whole-tree replacement updater.
- Keep German and English feature labels complete; other supported locales may
  fall back to English. Test daily controls and error/retry states, not only
  successful screenshots.
- Treat registry audit warnings as inputs to a dependency review. Confirm runtime
  reachability and compatible patched versions; do not use `npm audit fix --force`
  blindly or equate a Node/dev-tool advisory with a confirmed Worker exploit.
- For slow mail, compare the current deployment window, query plans/rows read,
  server timings and browser waterfalls. Existing access-path tests protect the
  60,000-message case. Do not cache private mail in a shared public cache.
- For a failed or uncertain send, inspect its recorded outcome before retrying.
  Provider confirmation and internal follow-up work are separate facts. A timeout
  is not proof of non-delivery. Keep the draft and its attachments until resolved.
  The five-minute cron recovers up to 20 due queued sends per run. A send left in
  `sending` for 15 minutes becomes `unknown` and is never automatically resent.
  Verify the recipient/provider outcome before a manual resend. A pre-provider
  failure can be returned to Drafts from Scheduled. Confirmed send receipts are
  saved atomically before audit/webhook follow-up; recovery finishes bookkeeping
  without calling the transport again. These changes need no schema migration.
- Check persisted job progress after leaving/reopening the app. Review final
  queue failures and blocked jobs deliberately; do not blindly replay messages
  that could already have been sent or uploaded.
  The primary administrator's **Administration → Background processing** card
  shows final-attempt failure notifications recorded in the last seven days.
  These are not live `mailflare-failed` queue counts: tasks may already be
  resolved, duplicate delivery may produce more than one notice, and database
  outages can prevent recording. Inspect Cloudflare Queues before any replay.
  The card loads once, offers manual refresh, caps its count at 100 (shown as
  “at least”), and lists five recent stages. Its authenticated, `private, no-store`
  API reads a bounded primary-key range from `audit_logs`; there is no new table
  or Cloudflare API request. Notices contain only stage, generic error category,
  attempt count and timestamp, without mail content, addresses or object keys.

Useful entry points: [deployment/bindings](deployment.md), [rescue and keys](rescue-backup.md),
[OAuth configuration](mcp-cloudflare-oauth.md), [mail providers](providers.md),
[upstream maintenance](upstream-maintenance.md), [troubleshooting](troubleshooting.md).
