import { describe, expect, it } from 'vitest';
import { normalizeMcpServerAlias, withoutContributedOwnership } from './serverOwnership.js';

describe('normalizeMcpServerAlias', () => {
  it('按模型工具命名规则识别大小写和分隔符冲突', () => {
    expect(normalizeMcpServerAlias('Tavily')).toBe('tavily');
    expect(normalizeMcpServerAlias('tavily-search')).toBe('tavily_search');
    expect(normalizeMcpServerAlias('tavily_search')).toBe('tavily_search');
  });
});

describe('withoutContributedOwnership', () => {
  it('同名用户配置不会继承小程序来源身份', () => {
    expect(withoutContributedOwnership({
      name: 'tavily',
      url: 'https://custom.example.com/mcp',
      ownerExtensionId: 'finch-tavily-search',
      ownerExtensionName: 'Tavily 搜索',
      qualifiedName: 'finch-tavily-search.tavily',
    })).toEqual({
      name: 'tavily',
      url: 'https://custom.example.com/mcp',
    });
  });
});
