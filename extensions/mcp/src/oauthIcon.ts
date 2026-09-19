/** MCP OAuth 固定使用包内 PNG，不探测或信任服务端提供的授权图标。 */
export function mcpOAuthIconUrl(extensionId: string): string {
  const separator = extensionId.indexOf('@');
  const owner = separator > 0
    ? `${encodeURIComponent(extensionId.slice(0, separator))}/${encodeURIComponent(extensionId.slice(separator + 1))}`
    : encodeURIComponent(extensionId);
  return `finch-ext-icon://${owner}/assets/mcp-oauth.png`;
}
