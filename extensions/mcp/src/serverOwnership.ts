export function normalizeMcpServerAlias(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

export interface McpServerOwnership {
  ownerExtensionId?: string;
  ownerExtensionName?: string;
  qualifiedName?: string;
}

/**
 * User-managed servers are always owned by the user, even when their display
 * name collides with a server contributed by a Mini Tool. Ownership metadata is
 * source-derived and must never leak in from a previous merged runtime snapshot.
 */
export function withoutContributedOwnership<T extends object>(server: T): T {
  const {
    ownerExtensionId: _ownerExtensionId,
    ownerExtensionName: _ownerExtensionName,
    qualifiedName: _qualifiedName,
    ...userServer
  } = server as T & McpServerOwnership;
  return userServer as T;
}
