# Send through Mailflare from the ChatGPT app

Use a private custom GPT with a GPT Action that calls Mailflare's existing
`POST /api/v1/send` endpoint. This sends through Mailflare's configured provider
and stores the sent copy in Mailflare immediately. It does not use Gmail.
This setup is for custom GPTs with Actions; it does not change the Gmail app in
regular ChatGPT conversations or install a native ChatGPT app automatically.

## Set up

1. In **Mailflare → Settings → API keys**, create a dedicated key named
   `ChatGPT Mailflare`. Leave **Allow MCP access** off, select **Send email**, and
   select only the mailbox you want to send from. Read, calendar and admin access
   are not needed for this action.
2. In the newly created key panel, expand **Send through Mailflare in the ChatGPT
   app**. Download the JSON template; if the key allows multiple mailboxes, choose
   the sending mailbox first. The template has the installation's HTTPS origin,
   mailbox ID and sender address filled in. It contains **no API key**.
3. In ChatGPT on desktop, create a private GPT and choose **Configure → Actions →
   Create new action**. Paste the downloaded JSON into the schema editor.
4. Set the action authentication to **API Key → Bearer**. Paste the Mailflare key
   into that authentication field. Never paste it into GPT instructions, the
   schema or a chat message.
5. Add these instructions to the GPT, save it privately, and open that GPT in the
   ChatGPT mobile app too:

   > Use `sendMailflareEmail` for sending email. Use Mailflare, never Gmail.
   > Show recipients, subject and the complete message before sending, and wait
   > for my approval. Only report success after Mailflare returns a messageId.
   > If the request times out or the result is uncertain, do not automatically
   > send again; ask me to check Mailflare's Sent folder first.

The action is marked `x-openai-isConsequential: true`. Sending requires the
client's confirmation. The initial template supports plain-text messages, To,
Cc and Bcc, and a fixed sending mailbox. It does not read mail or upload files.
Revoke the dedicated key in Mailflare to remove access.

## Cloudflare Access

ChatGPT's server must reach `/api/v1/send` without an interactive Access login.
An Access sign-in redirect is not an API response and does not authenticate a GPT
Action. ChatGPT's Bearer field holds the Mailflare API key, not a Cloudflare
Access service token.

Keep the web mailbox protected. If the installation currently requires Access
for every path, an administrator can create a more specific Access application
for **only `<mailflare-host>/api/v1/send`**, with an appropriate noninteractive
policy (or Bypass for that exact path). The application endpoint still enforces
its Mailflare API key, `send` scope, enabled user and mailbox permissions. Do not
bypass Access for the entire host, `/api/*`, administrative routes or mailbox
pages. No Access policies are changed automatically by this setup.

An unauthenticated POST to the exact send endpoint should return an application
**401 JSON**, not a redirect or HTML login. Validate this with an empty body and
without any key; it does not send a message. Test a real action only with an
explicitly approved recipient and message, then check **Sent** in Mailflare.

## Existing MCP endpoint

Mailflare also serves Streamable HTTP at `/mcp`. Its current authentication is a
mailbox-scoped Bearer key for clients that support setting that header; there is
no OAuth authorization-server implementation. Its `request_send` tool creates a
review link, and delivery is confirmed in a Mailflare browser session. That flow
is separate from this GPT Action and does not provide direct sending in the
ChatGPT app by itself.
