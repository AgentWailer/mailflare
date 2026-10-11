# Sender logos

Apple, Uber, Cloudflare, GitHub, PayPal, Spotify and Notion artwork comes from
[Simple Icons](https://github.com/simple-icons/simple-icons) (develop branch,
retrieved 2026-10-11); Amazon, OpenAI and Slack from release 14.0.0. Simple Icons
is distributed under CC0-1.0. Brand names and marks remain their owners’ property.
LinkedIn, Google and Microsoft use the existing local SVG artwork.

Matches use the sender domain, never the display name. A logo is decorative and
is not proof of sender identity. Personal contact pictures take priority.
Additional favicons are fetched on the server through Google’s favicon service
using only the company domain and cached per account in private R2 storage.
They are served through an authenticated, mailbox-authorized endpoint. Missing
images retain the sender initial; cached artwork expires after 30 days.
