# ChatGPT MCP through Cloudflare Managed OAuth

Cloudflare Access runs the OAuth authorization server, dynamic client registration,
PKCE and refresh-token flow. Mailflare verifies the signed user assertion forwarded
by Access and applies a separate, explicit origin grant. No static Mailflare key
or Access service-token secret is entered in ChatGPT.

## Administrator configuration

1. Keep the existing self-hosted Access application protecting the Mailflare Worker.
   Preserve its identity-provider and Service Auth policies.
2. In **Zero Trust → Access controls → Applications → Edit → Advanced settings**,
   enable **Managed OAuth**. Enable dynamic client registration, allow HTTPS
   redirect URIs on the trusted ChatGPT host (`https://chatgpt.com/*`), and leave
   arbitrary localhost/loopback redirects disabled. Use a short access-token
   lifetime (15 minutes) and a longer refresh-grant lifetime (14 days).
   If your ChatGPT client displays a different callback host, verify it against
   OpenAI's documentation before adding it; do not allow arbitrary destinations.
3. Configure these Worker bindings without overwriting other bindings:

   | Binding | Value |
   | --- | --- |
   | `MCP_ACCESS_ISSUER` | The organization's exact HTTPS Access issuer, such as `https://team.cloudflareaccess.com` |
   | `MCP_ACCESS_AUDIENCE` | The protected Access application's exact 64-character AUD value |

   Neither value is a user token. Both must match the application protecting MCP.
   For a self-hosted Node deployment behind Access, configure the same server
   environment variables and the public `APP_URL`.
4. Apply migration `0082_mcp_oauth_grants.sql` before deploying the new code.

Cloudflare documents Managed OAuth for self-hosted applications here:
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/

Access performs the OAuth discovery/challenge at the edge. Non-browser clients
receive a 401 with discovery information instead of an unusable login redirect.
Opaque OAuth tokens are resolved by Access; the origin verifies the resulting
`Cf-Access-Jwt-Assertion`, not the opaque token's contents. There is no second
Mailflare OAuth authorization server to configure.

## User connection

1. Open Mailflare through its protected public HTTPS origin, sign in normally,
   and open **Settings → API keys → Connect ChatGPT using OAuth**.
2. Check the displayed **Cloudflare login**. It may differ from the mailbox's
   email address. Choose an existing personal MCP key that defines the desired
   mailbox and calendar permissions. Create one with **Allow MCP access** first
   if needed. Administrative MCP keys cannot be selected.
3. Select **Allow access for this login**. This requires both an authenticated
   Mailflare session and a verified Access user assertion; knowing an email
   address or having Access access alone is insufficient.
4. In ChatGPT's custom-app connection settings, enter the displayed `/mcp` URL,
   choose OAuth and complete the browser login. Managed OAuth supports automatic
   client registration. A message pasted into a chat does not install the app;
   use the client's actual app-connection controls and enable it for the chat.
5. Test `get_calendars` and `list_mailboxes` when their scopes are granted. Use the
   mailbox IDs returned by the server. Calendar writes require their separate
   scope and save immediately. Sending requires `request_send` followed by a
   human confirmation in Mailflare; OAuth does not bypass that review.

One Access identity is linked to one local Mailflare account. Its stable issuer,
subject, audience and login email must continue matching the saved grant. Changing
an identity or audience requires explicit re-consent. The linked key remains the
permission boundary: disabled accounts, removed mailbox access and deleted keys
are checked on every request. Revoking the key also removes the OAuth grant.
The owner can revoke OAuth separately without disabling a local client's key.

## Validation and security

Mailflare accepts only RS256 assertions from the configured Access issuer and
application audience. It verifies signatures using that issuer's fixed
`/cdn-cgi/access/certs` endpoint, rejects expired/future-invalid assertions and
machine identities, and never trusts a forwarded email header alone. Certificate
responses are bounded, redirects are refused, the key cache is bounded, and
unknown key IDs have a refresh cooldown. Certificate failures fail closed.

Legacy Bearer clients remain supported. An invalid explicit API key never falls
back to an OAuth grant. Only personal mail/calendar MCP keys can back OAuth;
admin tools remain outside this flow. Backups include origin grants, but restore
disables them until an owner explicitly re-enables access. Copied connection
instructions contain no key, assertion or service-token secret.

Tests use generated RSA keys, actual database migrations and the actual MCP
handler for initialization, tool listing, calendar reads and mailbox scoping.
Browser checks exercise explicit consent, key selection and revocation on mobile
and desktop. A real ChatGPT login must still be completed by the account owner;
local tests do not establish that a particular ChatGPT conversation has the app
loaded.
