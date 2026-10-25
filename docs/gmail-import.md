# Google Workspace / Gmail import

Mailflare can copy a Google user's mailbox through the Gmail API. It requests only
`https://www.googleapis.com/auth/gmail.readonly`; it neither sends mail through
Google nor changes/deletes messages there. Each Google mailbox is connected
separately. Calendar, Drive, Chat and organization-wide domain delegation are outside
this importer.

## One-time setup in your existing Google Cloud project

1. Select your existing project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. Under **Google Auth Platform**, configure the app's Branding and Audience.
   For a project in your Workspace organization used only by its members, choose
   **Internal** when available. Otherwise configure External and add the importing
   Google accounts as test users. External apps in Testing normally have seven-day
   refresh tokens for this Gmail scope; production use may require Google's
   restricted-scope verification. Workspace administrators may also need to permit
   the OAuth client in their API controls.
4. Add the Gmail readonly scope under Data Access.
5. Create a **Web application** OAuth client. Register this exact authorized
   redirect URI for this installation:

   ```text
   https://mail.stepo-data.de/api/import/gmail/callback
   ```

6. In **Cloudflare → Workers & Pages → mailflare → Settings → Variables and Secrets**,
   configure:

   | Binding | Type | Value |
   | --- | --- | --- |
   | `GMAIL_OAUTH_CLIENT_ID` | Text | The OAuth web client's client ID |
   | `GMAIL_OAUTH_CLIENT_SECRET` | Secret | The matching client secret |
   | `GMAIL_OAUTH_REDIRECT_URI` | Text or Secret | The exact registered callback URI above |
   | `GMAIL_IMPORT_ENCRYPTION_KEY` | Secret | Base64 encoding of 32 cryptographically random bytes |

   These are **Worker bindings**, not merely credentials in the Codex execution
   environment. Do not put secrets in Git, chat, or the frontend. Keep the encryption
   key stable across deployments. A changed/lost key requires reconnecting Google;
   imported emails and saved import progress remain usable. In the Node runtime,
   supply these same variables through its server environment.

   On this managed installation, the encryption key and callback URI have already
   been prepared in the Worker. Only the Google client ID and client secret remain
   to be entered. Do not replace the existing encryption key while imports exist.

Google documentation: [OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

## Import

Open Mailflare at the configured callback origin and go to **Settings → Import**.
Use **Check setup again** after saving the Worker bindings. Choose **Connect Google**,
sign into the source account and authorize the read-only access. Confirm the source
Google address and selected Mailflare destination, then start the import.

For the first Google authorization, use a normal desktop/Safari browser with a
Mailflare login. Safari Home Screen apps can use separate cookie storage from the
browser opened by Google's login. Once connected, the connection and progress are
stored per Mailflare user and available on other logged-in devices.

Keep the import page open and foregrounded while running. It advances in small
batches with a checkpoint after each message. Pause takes effect after the current
step. Closing the page does not erase progress; reopen and Resume. An abandoned
batch lease expires after five minutes. API errors stop on the affected message;
they do not silently advance past it. Retry after rate limits or reconnect after
revoked/expired authorization. Messages larger than 40 MiB are detected before raw
download; export these separately and explicitly skip them if desired.

The importer preserves MIME content and attachments, original delivery timestamps,
Gmail conversations, read/unread state, stars, Inbox/Archive/Sent/Drafts/Spam/Trash
placement, Promotions/Social categories and multiple custom labels. Google's full
custom-label names (including slash paths) are preserved; slash paths are currently
created as full-name labels rather than converted into Mailflare parent/child
relationships. Existing message IDs are reused without overwriting current message
state; missing source labels are added. Counts distinguish newly imported and skipped
messages. The import is a snapshot bounded by its start time, not ongoing sync.

Removing a connection deletes its encrypted credentials and progress, retaining
imported emails. It does not revoke the Google-side grant; use your
[Google account connections](https://myaccount.google.com/connections) to revoke it.

## Security and operations

Authorization uses PKCE/S256, one-use 15-minute state bound to the initiating
Mailflare session, fixed HTTPS callback origin and session-authenticated writes
with origin checks. Access/refresh tokens stay on the server, encrypted with AES-GCM
and additional data bound to the user/connection. Public status responses expose
only addresses, configuration readiness and progress. Import targets require full
mailbox management permission, rechecked when resuming. Active-job uniqueness and
leases serialize concurrent starts/batches. Imported mail bypasses the inbound
classification and push-delivery pipeline.

Migration 0066 adds connections and jobs to the existing backup groups and table
lists. Short-lived OAuth states are excluded and cascade away on user restore.
Backups preserve encrypted credentials/checkpoints; restored running jobs become
paused with cleared leases. Restore the same encryption key or reconnect Google.

```sh
node --test tests/gmail-import.test.mjs tests/imap-import-batch.test.mjs tests/nested-labels.test.mjs
node tests/browser/gmail-import.mjs
```

## Continuously sync Gmail Sent

Under **Settings → Import → Google Workspace / Gmail**, connect the Google
account, select the destination mailbox and enable **Automatically sync sent
mail**. The same read-only OAuth grant is sufficient; no Gmail sending or write
permission is requested.

The server first scans **SENT only**, then uses Gmail history IDs to fetch new
sent messages about every five minutes. An anchor is saved before the initial
scan so messages sent during it are caught afterward. History IDs stay strings
without losing integer precision. Expired history triggers a sent-only repair
scan. Existing MIME Message-IDs skip raw downloads and preserve local state.
The selected Google connection has one fixed Mailflare destination.

Cloudflare Queue batches process up to three messages sequentially and checkpoint
each one; cron recovers lost dispatches and expired leases. The Node runtime also
runs recovery independently of the browser. Closing the app does not pause sync.
Full snapshot imports and sent-sync batches exclude each other's leases to avoid
concurrent duplicates. Incomplete copies stay hidden until attachments and
checkpoint commit. Revoked Google access or mailbox permissions stop sync;
transient errors back off automatically. Oversized/invalid messages are recorded
as individual issues while remaining mail continues; retry targets one issue.

This is a one-way copy of sent mail, including original recipients, Bcc, dates,
MIME content and attachments. It does not propagate later Gmail deletions or
change local stars/read state. Removing the Google connection stops sync and
removes its operational records, while completed Mailflare messages remain.
Backups include sent-sync settings, checkpoints and issue logs. Restore clears
leases and disables sync until the owner explicitly re-enables it.

Migration `0081_gmail_sent_sync.sql` is required. The existing OAuth Worker
bindings listed above must be configured and Google authorization completed by
the account owner before this can run. Gmail import setup is not automatically
completed by deploying this feature.

For sending directly from the ChatGPT app through Mailflare, see
[ChatGPT setup](chatgpt-mailflare.md).
