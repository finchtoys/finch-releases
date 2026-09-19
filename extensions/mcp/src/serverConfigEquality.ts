type ComparableValue = null | boolean | number | string | ComparableValue[] | { [key: string]: ComparableValue };

function normalize(value: unknown): ComparableValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((item): item is ComparableValue => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'secretRefs')
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, child]) => {
        const normalized = normalize(child);
        return normalized === undefined ? [] : [[key, normalized] as const];
      });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

function withDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  return { ...config, enabled: config.enabled !== false };
}

/** Compare effective MCP configs while ignoring encrypted-storage reference bookkeeping. */
export function sameMcpServerConfiguration(existing: unknown, next: unknown): boolean {
  return JSON.stringify(normalize(withDefaults(existing))) === JSON.stringify(normalize(withDefaults(next)));
}
