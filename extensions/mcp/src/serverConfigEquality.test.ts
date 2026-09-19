import { describe, expect, it } from 'vitest';
import { sameMcpServerConfiguration } from './serverConfigEquality.js';

describe('sameMcpServerConfiguration', () => {
  it('ignores key order, empty optional fields, and secret reference bookkeeping', () => {
    expect(sameMcpServerConfiguration(
      {
        name: 'notion',
        url: 'https://mcp.notion.com/mcp',
        oauth: { providerName: 'notion', id: 'notion' },
        env: {},
        secretRefs: { MCP_AUTH_TOKEN: 'encrypted-ref' },
      },
      {
        oauth: { id: 'notion', providerName: 'notion' },
        enabled: true,
        url: 'https://mcp.notion.com/mcp',
        name: 'notion',
      },
    )).toBe(true);
  });

  it('detects effective configuration changes', () => {
    expect(sameMcpServerConfiguration(
      { name: 'notion', url: 'https://mcp.notion.com/mcp', oauth: { id: 'notion' } },
      { name: 'notion', url: 'https://example.com/mcp', oauth: { id: 'notion' } },
    )).toBe(false);
  });
});
