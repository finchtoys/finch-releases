import { describe, expect, it } from 'vitest';
import { unconfiguredContributedServers } from './contributedPlaceholders.js';

const tavily = {
  name: 'Tavily',
  description: 'Tavily Search MCP server.',
  ownerExtensionId: 'finch-tavily-search',
  ownerExtensionName: 'Tavily 搜索',
  qualifiedName: 'finch-tavily-search.Tavily',
};

describe('unconfiguredContributedServers', () => {
  it('已声明但未注册的贡献服务仍然出现，避免被占用的名字在列表里消失', () => {
    expect(unconfiguredContributedServers([tavily], [])).toEqual([tavily]);
  });

  it('按归一化别名判断是否已注册，大小写与分隔符差异不算未注册', () => {
    expect(unconfiguredContributedServers([tavily], ['tavily'])).toEqual([]);
    expect(unconfiguredContributedServers([{ ...tavily, name: 'tavily-search' }], ['tavily_search'])).toEqual([]);
  });

  it('用户同名的自定义服务覆盖贡献声明后，不再补出未配置卡片', () => {
    expect(unconfiguredContributedServers([tavily], ['tavily', 'notion'])).toEqual([]);
  });

  it('只补出缺失的那一项，已注册的贡献服务保持原样', () => {
    const chrome = { name: 'chrome-devtools', ownerExtensionId: 'finch-chrome-devtools' };
    expect(unconfiguredContributedServers([chrome, tavily], ['chrome-devtools'])).toEqual([tavily]);
  });
});
