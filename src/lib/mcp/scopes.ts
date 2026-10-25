export const MAIL_MCP_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"] as const;
export function isMailMcpScope(scope:string) { return (MAIL_MCP_SCOPES as readonly string[]).includes(scope); }
