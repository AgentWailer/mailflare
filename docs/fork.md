# AgentWailer Mailflare fork

Modified 10 October 2026; distributed under AGPL-3.0-or-later. Original copyright and license notices remain in LICENSE.

## Feature policy

`src/lib/licenses/features.ts` defines the capabilities shared by the entitlement service and mailbox-access checks. Branding, account management, shared inboxes, booking hosts and forwarding are enabled, with unlimited account seats. No provider API call, purchased key, license table or environment flag is needed to enable these capabilities. Historical license records are preserved; their expiry or deactivation does not change fork capabilities. Legacy license activation endpoints still describe purchased licenses, not the effective feature policy of this fork.

Login, disabled-account checks, admin roles, primary-admin checks, API scopes, domain ownership and delegated mailbox permissions continue to apply. Enabling shared inboxes does not grant every user or admin access to every inbox. External email/AI services still require their normal credentials and may charge for usage.

The first-run account is the primary admin. Deploying this fork does not change existing users' roles. If your current account cannot reach owner-only pages after deployment, inspect your authenticated `/api/auth/me` response for `role` and `isPrimaryAdmin`. Verify the intended account and existing primary admin before performing any account recovery; never promote all users or remove the primary-admin check.

## Deploy on the existing Cloudflare installation

1. Commit and publish the reviewed fork changes in `AgentWailer/mailflare`. The source link displayed throughout the application must give users access to the corresponding modified source. Keep LICENSE and the modification notice; keep the source link accessible when changing branding. If you move the fork, update `src/lib/fork.ts`.
2. Use the existing Cloudflare Worker and its current D1, R2, queues, bindings and secrets. Confirm that the deploy configuration targets the running installation; do not create a replacement database or initialize a new admin account. Preserve the existing Worker configuration and a current data backup.
3. Run `npm ci`, `npm run build`, then deploy the reviewed branch through the existing Cloudflare Git integration, or run `npm run deploy` with authorized Wrangler authentication. The repository's Worker name is `mailflare`; check it against the existing installation before deploying. This change adds no schema migration and requires no remote D1 command.
4. Sign in with the existing owner account. Check the enabled-features page at `/licenses`, account management, branding, sharing and forwarding. Verify a non-admin account still cannot administer the installation, and shared-mailbox users receive only delegated permissions.

No deployment or remote account change was performed as part of the local fork implementation.

## Updates

The original updater replaces the entire tracked tree with upstream source. This fork blocks that operation in the backend (HTTP 409 after authorization), shows manual update instructions, and does not make GitHub version-check or dispatch requests. Database migration status and the authenticated migration action are unaffected.

Merge upstream changes into this fork, preserving the feature policy, update guard and source offer; resolve conflicts, test, and deploy the reviewed result. Disable any separately configured scheduled/external replacement workflow in the installation repository; the application cannot stop an externally dispatched GitHub workflow. There is no such workflow in this checkout.

## Local validation

From `/workspace/mailflare`, use the configured writable cache paths:

```bash
export XDG_CACHE_HOME=/workspace/.cache
export XDG_CONFIG_HOME=/workspace/.config
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_VITE_FORCE_LOCAL=true
node --test tests/self-hosted-features.test.mjs tests/account-alias-selection.test.mjs
npm run build
npm run dev -- --host 127.0.0.1
```

Focused tests cover unlicensed account management and branding, unlimited accounts, preserved historical license data, ordinary-user and primary-admin restrictions, shared-mailbox delegation, and prevention of external update dispatches. The feature UI is localized in English and German; other locales use the existing English fallback for the new strings.
