import type { McpAgentInstructionsProps } from "./mcp-agent-instructions-types";

export function buildMcpAgentPrompt(origin: string, { mode }: McpAgentInstructionsProps): string {
	const serverUrl = `${origin || "https://your-mailflare-domain"}/mcp`;
	const instructions = mode === "mail"
		? "Use get_calendars for calendar access and list_mailboxes for mail access when available. Use only the tools and mailbox IDs returned by this server. Calendar changes save immediately. Sending mail requires a review request and confirmation in Mailflare."
		: "Use only the admin management tools and permissions exposed by this key. This key cannot read or send mail.";

	const authentication = mode === "mail"
		? "For ChatGPT: enable the OAuth connection in Mailflare Settings → API keys, then add this URL as an app using OAuth and complete the browser login. Pasting this message does not register the app. For a local MCP client with custom headers, enter the separately copied API key in its secure Bearer authentication field."
		: "For an MCP client with custom headers, enter the separately copied admin API key in its secure Bearer authentication field. Admin keys do not use the personal ChatGPT OAuth connection.";
	return `Mailflare MCP server:\nServer URL: ${serverUrl}\nTransport: Streamable HTTP\n\n${authentication}\n\n${instructions}\nDo not paste API keys into a chat or include them in replies or logs.`;
}
