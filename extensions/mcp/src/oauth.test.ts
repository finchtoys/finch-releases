import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import type { OAuthStorage } from './oauth.js';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@modelcontextprotocol/client', () => ({ auth: authMock }));

const {
  authorizeMcpOAuth, createMcpOAuthProvider, requiresMcpOAuthAuthorization,
  FINCH_MCP_OAUTH_CALLBACK_URL,
} = await import('./oauth.js');

type StoredState = {
  clientInformation?: { client_id: string };
  clientRegistrationVersion?: number;
  clientRegistrationRedirect?: string;
  tokens?: { access_token: string; token_type: string; refresh_token?: string };
};

function createStorage(initial?: StoredState) {
  let value = structuredClone(initial);
  const set = vi.fn(async (_key: string, next: unknown) => { value = structuredClone(next as StoredState); });
  const remove = vi.fn(async () => { value = undefined; });
  const storage: OAuthStorage = {
    async get<T>() { return structuredClone(value) as T | undefined; },
    set,
    delete: remove,
  };
  return { storage, set, remove, current: () => structuredClone(value) };
}

const config = { id: 'notion', providerName: 'Notion', clientName: 'Finch' };
const endpoint = 'https://mcp.example/mcp';
const healthy: StoredState = {
  clientInformation: { client_id: 'existing-client' },
  clientRegistrationVersion: 5,
  clientRegistrationRedirect: FINCH_MCP_OAUTH_CALLBACK_URL,
  tokens: { access_token: 'existing-token', refresh_token: 'existing-refresh', token_type: 'bearer' },
};

beforeEach(() => authMock.mockReset());
afterEach(() => vi.unstubAllEnvs());

async function requestCode(provider: OAuthClientProvider) {
  const url = new URL('https://auth.example/authorize');
  url.searchParams.set('state', await provider.state!());
  url.searchParams.set('redirect_uri', String(provider.redirectUrl));
  await provider.saveCodeVerifier('one-use-verifier');
  await provider.redirectToAuthorization(url);
  return 'REDIRECT';
}

describe('固定 HTTPS callback 与注册兼容', () => {
  it('忽略遗留 Dev 环境变量，DCR、授权和 token provider 使用同一固定回调', async () => {
    vi.stubEnv('FINCH_DEV_MCP_OAUTH_CALLBACK_URL', 'http://127.0.0.1:49152/oauth/callback');
    const { storage } = createStorage();
    const initiateAuthorization = vi.fn(async () => ({ code: 'code' }));
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      expect(provider.redirectUrl).toBe(FINCH_MCP_OAUTH_CALLBACK_URL);
      expect(provider.clientMetadata.redirect_uris).toEqual([FINCH_MCP_OAUTH_CALLBACK_URL]);
      return requestCode(provider);
    }).mockImplementationOnce(async (provider: OAuthClientProvider) => {
      expect(provider.redirectUrl).toBe(FINCH_MCP_OAUTH_CALLBACK_URL);
      return 'AUTHORIZED';
    });
    await authorizeMcpOAuth(endpoint, config, storage, { initiateAuthorization });
    expect(initiateAuthorization).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: FINCH_MCP_OAUTH_CALLBACK_URL }));
    expect((await createMcpOAuthProvider(config, storage)).redirectUrl).toBe(FINCH_MCP_OAUTH_CALLBACK_URL);
  });

  it('已记录当前回调的 v5 注册继续复用', async () => {
    const { storage } = createStorage(healthy);
    expect(await (await createMcpOAuthProvider(config, storage)).clientInformation()).toEqual(healthy.clientInformation);
  });

  it.each([
    { label: '没有记录回调的旧 v5 注册', state: { ...healthy, clientRegistrationRedirect: undefined } },
    { label: '记录的是别的回调', state: { ...healthy, clientRegistrationRedirect: 'http://127.0.0.1:49152/oauth/callback' } },
    { label: '临时 v7 注册', state: { ...healthy, clientRegistrationVersion: 7 } },
  ])('不复用$label，强制重新做一次动态注册', async ({ state }) => {
    const { storage } = createStorage(state);
    expect(await (await createMcpOAuthProvider(config, storage)).clientInformation()).toBeUndefined();
  });

  it('新注册保持 v5 身份并记录当前回调', async () => {
    const { storage, current } = createStorage();
    const provider = await createMcpOAuthProvider(config, storage);
    await provider.saveClientInformation!({ client_id: 'new-client' });
    expect(current()).toMatchObject({ clientRegistrationVersion: 5, clientRegistrationRedirect: FINCH_MCP_OAUTH_CALLBACK_URL });
  });
});

describe('普通连接与明确重新授权', () => {
  it('已有匹配凭据时不调用 auth、不打开浏览器，也不重写存储', async () => {
    const { storage, set } = createStorage(healthy);
    const initiateAuthorization = vi.fn();
    await authorizeMcpOAuth(endpoint, config, storage, { initiateAuthorization });
    expect(authMock).not.toHaveBeenCalled();
    expect(initiateAuthorization).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('首次没有 Token 时仍授权，scopes 与受信任图标保持原值', async () => {
    const { storage } = createStorage();
    const initiateAuthorization = vi.fn(async () => ({ code: 'new-code' }));
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider, options) => {
      expect(options.forceReauthorization).toBe(false);
      expect(options.scope).toBe('read write');
      return requestCode(provider);
    }).mockImplementationOnce(async (provider: OAuthClientProvider, options) => {
      expect(options.authorizationCode).toBe('new-code');
      expect(await provider.codeVerifier()).toBe('one-use-verifier');
      return 'AUTHORIZED';
    });
    await authorizeMcpOAuth(endpoint, { ...config, scopes: ['read', 'write'], providerIcon: 'finch-ext-icon://notion/icon.png' }, storage, { initiateAuthorization });
    expect(initiateAuthorization).toHaveBeenCalledWith(expect.objectContaining({ providerIcon: 'finch-ext-icon://notion/icon.png' }));
    expect(authMock).toHaveBeenCalledTimes(2);
  });

  it('用户明确重新授权时不因已有 Token 而跳过浏览器', async () => {
    const { storage } = createStorage(healthy);
    const initiateAuthorization = vi.fn(async () => ({ code: 'new-code' }));
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider, options) => {
      expect(options.forceReauthorization).toBe(true);
      return requestCode(provider);
    }).mockResolvedValueOnce('AUTHORIZED');
    await authorizeMcpOAuth(endpoint, config, storage, { initiateAuthorization }, true);
    expect(initiateAuthorization).toHaveBeenCalledOnce();
  });

  it('回调没有 code 时明确失败，不开始交换', async () => {
    const { storage } = createStorage();
    authMock.mockImplementationOnce(requestCode);
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => ({ code: '' }),
    })).rejects.toThrow('did not return an authorization code');
    expect(authMock).toHaveBeenCalledOnce();
  });

  it('交换未完成不能报告授权成功', async () => {
    const { storage } = createStorage();
    authMock.mockImplementationOnce(requestCode).mockResolvedValueOnce('REDIRECT');
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => ({ code: 'code' }),
    })).rejects.toThrow('code exchange did not complete');
  });
});

describe('取消恢复与 SDK 失效化边界', () => {
  it.each(['OAuth login cancelled', '登录已取消', 'access_denied'])('交互明确取消 %s 时恢复原凭据', async (message) => {
    const { storage, current } = createStorage(healthy);
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.saveClientInformation!({ client_id: 'temporary-client' });
      return requestCode(provider);
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => { throw new Error(message); },
    }, true)).rejects.toThrow(message);
    expect(current()).toEqual(healthy);
  });

  it('首次授权取消时删除本轮新建状态', async () => {
    const { storage, current, remove } = createStorage();
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.saveClientInformation!({ client_id: 'temporary-client' });
      return requestCode(provider);
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => { throw new Error('OAuth login cancelled'); },
    })).rejects.toThrow('cancelled');
    expect(current()).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(['all', 'client', 'tokens'] as const)('SDK 失效化 %s 后，即使取消也不恢复失效凭据', async (scope) => {
    const { storage, current } = createStorage(healthy);
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.invalidateCredentials!(scope);
      return requestCode(provider);
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => { throw new Error('OAuth login cancelled'); },
    }, true)).rejects.toThrow('cancelled');
    if (scope === 'all' || scope === 'client') expect(current()?.clientInformation).toBeUndefined();
    if (scope === 'all' || scope === 'tokens') expect(current()?.tokens).toBeUndefined();
  });

  it('普通网络错误不回滚 SDK 刚写入的新 Token', async () => {
    const { storage, current } = createStorage(healthy);
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.saveTokens({ access_token: 'rotated-token', token_type: 'bearer' });
      throw new Error('Network unavailable');
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: vi.fn(),
    }, true)).rejects.toThrow('Network unavailable');
    expect(current()?.tokens?.access_token).toBe('rotated-token');
  });

  it('交互超时不被当作用户取消', async () => {
    const { storage, current } = createStorage(healthy);
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.saveClientInformation!({ client_id: 'new-client' });
      return requestCode(provider);
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => { throw new Error('OAuth request timed out'); },
    }, true)).rejects.toThrow('timed out');
    expect(current()?.clientInformation?.client_id).toBe('new-client');
  });

  it('code 交换失败后不复活 SDK 已清理的 Token', async () => {
    const { storage, current } = createStorage(healthy);
    authMock.mockImplementationOnce(requestCode).mockImplementationOnce(async (provider: OAuthClientProvider) => {
      await provider.invalidateCredentials!('tokens');
      throw new Error('invalid_grant');
    });
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => ({ code: 'code' }),
    }, true)).rejects.toThrow('invalid_grant');
    expect(current()?.tokens).toBeUndefined();
  });

  it('恢复存储失败时同时保留取消与存储错误', async () => {
    const { storage, set } = createStorage(healthy);
    const restoreError = new Error('Storage unavailable');
    authMock.mockImplementationOnce(requestCode);
    set.mockRejectedValueOnce(restoreError);
    await expect(authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => { throw new Error('OAuth login cancelled'); },
    }, true)).rejects.toMatchObject({
      name: 'AggregateError', errors: [expect.any(Error), restoreError],
    });
  });

  it.each([false, true])('成功或取消（%s）后都释放内存 PKCE verifier', async (cancel) => {
    const { storage, current } = createStorage();
    let seenProvider: OAuthClientProvider | undefined;
    authMock.mockImplementationOnce(async (provider: OAuthClientProvider) => {
      seenProvider = provider;
      return requestCode(provider);
    }).mockResolvedValueOnce('AUTHORIZED');
    const result = authorizeMcpOAuth(endpoint, config, storage, {
      initiateAuthorization: async () => {
        if (cancel) throw new Error('OAuth login cancelled');
        return { code: 'code' };
      },
    });
    if (cancel) await expect(result).rejects.toThrow('cancelled');
    else await result;
    await expect(seenProvider!.codeVerifier()).rejects.toThrow('PKCE verifier is missing');
    expect(JSON.stringify(current() ?? {})).not.toContain('one-use-verifier');
  });
});

describe('授权上下文变化', () => {
  const original = { url: endpoint, oauth: { ...config, scopes: ['read', 'write'] } };

  it('首次 OAuth、地址或账户变化时需要授权', () => {
    expect(requiresMcpOAuthAuthorization(undefined, original)).toBe(true);
    expect(requiresMcpOAuthAuthorization(original, { ...original, url: 'https://other.example/mcp' })).toBe(true);
    expect(requiresMcpOAuthAuthorization(original, { ...original, oauth: { ...original.oauth, id: 'another' } })).toBe(true);
  });

  it('展示名和 scope 顺序变化不等于重新授权', () => {
    expect(requiresMcpOAuthAuthorization(original, {
      ...original, oauth: { ...original.oauth, providerName: '新展示名', scopes: ['write', 'read', 'read'] },
    })).toBe(false);
  });

  it('实际 scope 集合变化时重新授权', () => {
    expect(requiresMcpOAuthAuthorization(original, { ...original, oauth: { ...original.oauth, scopes: ['read'] } })).toBe(true);
  });

  it('非 OAuth 连接不请求 OAuth 授权', () => {
    expect(requiresMcpOAuthAuthorization(original, { url: endpoint })).toBe(false);
  });
});
