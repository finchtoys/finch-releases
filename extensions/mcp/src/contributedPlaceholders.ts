import { normalizeMcpServerAlias } from './serverOwnership.js';

/** Minimal shape of a `contributes.mcpServers` entry kept for presentation and ownership. */
export interface ContributedServerDescriptor {
  name: string;
  description?: string;
  ownerExtensionId?: string;
  ownerExtensionName?: string;
  qualifiedName?: string;
}

/**
 * Status reported for a declared server that has no transport to connect with yet.
 * It is deliberately distinct from `pending`/`failed`: nothing is scheduled to connect,
 * so the connection badges (连接中 / 连接失败) would be wrong.
 */
export const UNCONFIGURED_SERVER_STATUS = 'unconfigured';

/**
 * Contributed servers that an enabled Mini Tool declares but that currently have
 * nothing to connect with: the `contributes.mcpServers` entry has no transport and
 * the owning Mini Tool's companion `registerServer()` call has not landed (Tavily
 * before its API key is saved, after the key could not be decrypted, or after a
 * registration that failed).
 *
 * These entries must stay visible in the Toolcase list. Their alias still occupies the
 * `mcp__<server>__<tool>` namespace and blocks same-name user configuration, so hiding
 * them makes the naming conflict unexplainable — the list looks empty while the name
 * is taken.
 */
export function unconfiguredContributedServers<T extends ContributedServerDescriptor>(
  contributed: readonly T[],
  registeredNames: Iterable<string>,
): T[] {
  const registered = new Set<string>();
  for (const name of registeredNames) registered.add(normalizeMcpServerAlias(name));
  return contributed.filter((server) => !registered.has(normalizeMcpServerAlias(server.name)));
}
