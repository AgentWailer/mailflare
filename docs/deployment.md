# Deployment and configuration

This guide covers new Cloudflare installations and binding configuration for the `AgentWailer/mailflare` fork. For an existing installation, use the [current operating guide](operations.md), especially the migration-before-code release procedure and recovery into empty resources. Do not follow upstream replacement workflows for this fork.

## Overview

Set up Mailflare in three steps:

1. **Deploy the app:** use the Deploy to Cloudflare button, set the app name to `mailflare`, and provide the required `CF_TOKEN`.
2. **Complete setup:** open the deployed app and follow `/setup` to check the installation and create the first admin account.
3. **Connect your domain:** add a domain managed by the same Cloudflare account and choose which service receives its mail. Mailflare configures email routing and, when available and selected, email sending before helping you create the first mailbox. Resend and Amazon SES are alternatives to Cloudflare for receiving and sending; see [Sending and receiving providers](providers.md).


## Step 1: Setup CF_TOKEN
To configure your `CF_TOKEN` (which is a scoped Cloudflare API Token with specific permissions), follow the below steps.

1. In your Cloudflare account, navigate to `Manage Account` → `Account API Tokens` and create a new token.
2. At the top of the Policy window, select `Specified Domains` for all domains that you plan to connect
    1. Then configure these permissions
        1. DNS & Zones > DNS > Select `Edit` Access
            1. This allows the confirmed setup flow to replace conflicting MX records
        2. DNS & Zones > Zone > Select `Read` Access
        3. DNS & Zones → Zone Settings → Select `Edit` Access
        4. Email & Messaging > Email Routing Rules > Select `Edit` Access
3. If mailflare will send emails: Add another policy and select `Entire Account`, and configure these permissions:
    1. Email & Messaging > Email Sending > Select `Edit` Access
4. After your token is setup, go to `Compute` → `Email Service` → `Email Sending`
    1. You will need to purchase a paid workers plan if you don't already have one
    2. Select On-board domain and follow the prompts
    3. After this is done, and after you have setup Mailflare, on the Admin > domains page, when you expand the domain you can then configure DKIM and DMARC records

Paste only the token secret into the `CF_TOKEN` field in step 2. Do not include the word `Bearer` and do not use the token ID. The token must belong to the same Cloudflare account as the domains you connect.

## Step 2: Deploy mailflare

1. For a new installation, click **Deploy to Cloudflare**, verify the repository is `AgentWailer/mailflare`, and sign in to Cloudflare if prompted.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AgentWailer/mailflare)

2. Choose the Cloudflare account that owns the domain you want to use.
3. Set the app name to exactly `mailflare`. Do not rename it. 
4. Add the runtime `CF_TOKEN` when Cloudflare asks for the app's secrets. It is separate from the deployment credential (`CLOUDFLARE_API_TOKEN` in Wrangler); never copy a deployment administrator token into a client or chat.
5. Start the deployment and wait for Cloudflare to finish provisioning and deploying the Worker.


### Optional Web Push configuration

To enable background new-mail notifications, run `npm run push:keys` once and
store `VAPID_PRIVATE_KEY` as a Worker secret. Configure `VAPID_PUBLIC_KEY` and
`VAPID_SUBJECT` as Worker variables; the subject must be a `mailto:` URI or the
public HTTPS URL of the installation. The same VAPID key pair should be kept
across deployments so existing browser subscriptions remain valid.

## Step 3: Complete mailflare setup

1. Open the URL of the deployed `mailflare` Worker.
2. Go to `/setup` if Mailflare does not take you there automatically.
3. Let Mailflare check the required Cloudflare configuration and initialize the empty D1 database.
4. Create the first admin account when prompted.

Setup applies the committed migrations through the Worker's D1 binding before creating the first admin account.

## Step 4: Connect your primary domain and create an account

1. Enter a domain that already uses Cloudflare DNS on the same account as your `CF_TOKEN`.
2. Continue while Mailflare enables Email Routing and configures the required routing and sending DNS.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

To connect more domains later, open **Admin → Domains**, select **New domain**, enter the hostname and choose the receiving service. With Cloudflare, Mailflare configures Email Routing and Email Sending automatically. With Resend or Amazon SES, add the provider's credentials and run its setup from the domain page; see [Sending and receiving providers](providers.md). The `CF_TOKEN` is still needed in every case, because Cloudflare manages the domain's DNS.

Resend and SES receive mail by calling your app, so set `APP_URL` to the app's public HTTPS address before setting them up for receiving.

Your inbox should be ready to send and receive emails

---

## Manual deployment

For a new installation, install locked dependencies and configure the complete bindings in `wrangler.jsonc`, including the private live/rescue buckets and queue dead-letter target. Validate before an authorized manual deployment:

```bash
npm ci
npm run check:quality
npm run test:smoke
npm run deploy:local
```

For an existing Git-connected installation, publish the reviewed commit through that existing pipeline after the [release checks and migrations](operations.md#release-an-existing-installation). Do not create replacement production resources or use `/setup` on a populated database.

The local deploy command builds with vinext and uploads the complete Worker with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to that build. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups, and the real-time Durable Object.

For an existing installation, inspect pending migrations and apply any required additive migration **before** publishing code that selects its new columns. After verifying the account, database binding and available recovery point, use:

```bash
npx wrangler d1 migrations list DB --remote
npm run db:migrate:remote
npx wrangler d1 migrations list DB --remote
```

Remote migrations require the target account's `database_id` in your local `wrangler.jsonc`. Do not commit an account-specific database ID to a reusable repository.

## Object storage (R2, Backblaze B2 or AWS S3)

Raw mail, attachments, Drive files, avatars, branding icons and JMAP uploads use the `BUCKET` binding. Legacy record exports used that bucket too. The current encrypted rescue copy is deliberately separate, using the private R2 `RESCUE_BUCKET` binding; the live-provider substitution described below does not replace that rescue destination. By default live objects use R2. To use Backblaze B2 instead, set four Worker variables (as secrets, or in `.dev.vars` locally):

| Variable | Example | Purpose |
| --- | --- | --- |
| `B2_KEY_ID` | `004abc...` | Application key ID |
| `B2_APPLICATION_KEY` | `K004...` | Application key secret |
| `B2_BUCKET` | `mailflare` | Bucket name |
| `B2_ENDPOINT` | `s3.us-west-004.backblazeb2.com` | S3-compatible endpoint from the bucket page; the region is read from it |

```bash
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_BUCKET
npx wrangler secret put B2_ENDPOINT
```

To use AWS S3 instead, set `S3_BUCKET`, `S3_REGION` and credentials: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, which fall back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` so one IAM user can serve SES and storage. The bucket must be private and in the named region; the IAM user needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on `arn:aws:s3:::<bucket>/*`. If both are configured, B2 wins.

When all four B2 variables (or the S3 ones) are present that storage replaces R2 everywhere; with any missing, R2 stays in use (a partial setup is reported by `GET /api/v1/storage`). The R2 binding can stay in `wrangler.jsonc` and is simply unused. Use a bucket-restricted application key with read and write access, and keep the bucket private. Notes:

- **Switching does not copy data.** Objects already in R2 are not moved; copy them to the bucket first (for example with `rclone`, keeping the same keys) or old mail bodies, attachments and Drive files will report as missing.
- **Drive upload parts** are buffered one at a time in the Worker (64 MB each). B2 and S3 require every part but the last to be at least 5 MB, which holds.
- **Lifecycle.** Set the bucket's lifecycle rule to keep only the last version and to delete unfinished large files after a few days, as R2 would abort incomplete multipart uploads.
- **Test it** with `POST /api/v1/storage` (admin key with the `storage` scope), or the `manage_storage` MCP tool with `action: "test"`; it writes, reads and deletes a small object.

## Backup and recovery

Use [D1 Time Travel and the encrypted rescue copy](rescue-backup.md). Time Travel
covers database history; it does not recover deleted R2 objects. The rescue copy
includes the database and referenced files in a separate private R2 bucket.
Keep the downloaded private recovery key and its password outside the Worker.

The `0 2 * * *` cron checks the configured backup schedule; it does not imply a
new full backup every day. The current rescue policy maintains one verified
recovery point, reuses unchanged object blocks and retains the previous point
until a replacement has been verified. Configure the actual interval under
**Administration → Backups**. The five-minute cron resumes interrupted work.

Recover and verify locally, import into **new empty D1/R2 resources**, verify the
result, then switch bindings. Keep the existing resources until verification is
complete. The old JSON upload/restore procedure is not the Cloudflare recovery
path. Historical record-export details remain in [database-backups.md](database-backups.md),
marked as legacy. Deployment configuration and secrets require their own secure
inventory; the data backup does not recreate them.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `mailflare-agent` queue. Provision the queue in the Cloudflare account before deploying a configuration that declares it. Review and apply all required pending additive migrations before dependent code; `0032_add_agentic_mail.sql` introduced the original agent tables, but it is not the latest complete schema. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

In the inbox, open **Assistant → Settings** for a mailbox, select its reviewer, and enable the assistant. Auto-drafting is a separate opt-in. It skips spam, automated mail, and mailboxes with out-of-office replies enabled. Generated replies appear as ordinary drafts assigned to the reviewer. The reviewer must open the draft and confirm the exact content before delivery.

Manage MCP keys and OAuth grants under **Settings → API keys**. For ChatGPT,
use [Cloudflare Managed OAuth](mcp-cloudflare-oauth.md): Access runs the OAuth
server and Mailflare verifies the identity assertion plus an explicit account
and permission grant. No fixed Mailflare key or Access service-token secret is
pasted into ChatGPT. Compatible local clients can still use a scoped Bearer key.

The Streamable HTTP endpoint is `/mcp`. Read/draft tools do not require Workers
AI. `request_send` returns a Mailflare review URL; the user confirms delivery in
Mailflare. Calendar writes use their separate scopes and save immediately.

## Updating Mailflare

This AgentWailer fork disables the original automatic updater. That updater replaces the complete tracked tree with upstream code and would remove this fork's feature policy. The admin update endpoint returns HTTP 409 instead of dispatching a GitHub Action, even when update tokens remain configured. Database migration checks and the **Update database** action remain available.

Merge upstream changes into `AgentWailer/mailflare`, review them, run the fork tests and build, and deploy the fork through your Cloudflare Git integration or Wrangler. Do not install or dispatch the original `deploy-update.yml` replacement workflow. See [Fork operation and deployment](fork.md).

Deployment and migration are separate operations with an explicit release
order. Inspect the candidate commit's migration files and schema consumers.
Apply and verify backward-compatible additive migrations **before** deploying
code that immediately references their new columns. For example, releases using
`reply_to` and `header_metadata` require migrations 0083 and 0084 respectively.
Do not assume an inaccessible new Admin page can repair an incompatible schema.

The Admin migration action is useful when the running code can operate with the
current schema. It is not a universal deploy-first migration strategy. Do not
remove a migration step from an existing pipeline without replacing it with an
explicitly ordered and verified release step. Destructive or non-compatible
changes require a separate staged migration and recovery plan.

Each migration and its history entry run in one D1 batch. A failed migration can
be retried after its cause is corrected. Preserve applied migration files and
history. Roll back application code while retaining compatible additive columns;
never restore the entire live database merely to undo a UI/code release. See the
[release and rollback checklist](operations.md#release-an-existing-installation).

When adding a schema change, create a new uniquely named SQL file in `drizzle/migrations` and do not edit an applied migration. Build and development commands generate the Worker migration bundle from those files. `npm run db:bundle` can generate it explicitly.

## Features in this fork

Branding, account management, shared inboxes, booking hosts and email forwarding are enabled without a key. Accounts have no license seat limit. Existing license records and the legacy activation API remain for compatibility, but they do not control this fork's feature access. **Admin → Licenses** explains this policy instead of offering an upgrade.
