import { getEmailAddress } from "@/lib/email/address";

const personalMailDomains = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "aol.com", "gmx.de", "gmx.net", "web.de", "proton.me", "protonmail.com", "t-online.de"]);

const knownLogos: Record<string, string> = {
	"linkedin.com": "linkedin", "google.com": "google", "microsoft.com": "microsoft",
	"cloudflare.com": "cloudflare", "uber.com": "uber", "ubereats.com": "uber",
	"amazon.com": "amazon", "amazon.de": "amazon", "amazon.co.uk": "amazon",
	"amazon.fr": "amazon", "amazon.it": "amazon", "amazon.es": "amazon",
	"apple.com": "apple", "github.com": "github",
	"paypal.com": "paypal", "paypal.de": "paypal", "spotify.com": "spotify",
	"openai.com": "openai", "chatgpt.com": "openai", "slack.com": "slack",
	"notion.so": "notion", "notion.com": "notion",
};

export function senderLogoDomain(address: string): string | null {
	const email = getEmailAddress(address).trim().toLowerCase();
	if (email.split("@").length !== 2) return null;
	const domain = email.split("@")[1];
	if (personalMailDomains.has(domain)) return null;
	if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
	if (/\.(?:local|localhost|internal|test|invalid|example)$/.test(domain)) return null;
	return domain;
}

export function knownSenderLogo(address: string): string | null {
	const domain = senderLogoDomain(address);
	return domain ? Object.entries(knownLogos).find(([host]) => domain === host || domain.endsWith(`.${host}`))?.[1] ?? null : null;
}
