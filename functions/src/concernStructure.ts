/**
 * Normalizes a free-form string array input for concern structure fields.
 * - Accepts any value; only arrays of strings are processed.
 * - Trims whitespace, removes empty entries.
 * - Enforces max items & per-item max length.
 * - Returns null if no valid entries remain (so callers can FieldValue.delete()).
 */
export function normalizeStringArray(v: any, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .map(x => (typeof x === 'string' ? x.trim() : ''))
    .filter(x => x.length > 0)
    .slice(0, maxItems)
    .map(x => (x.length > maxLen ? x.slice(0, maxLen) : x));
  return out.length ? out : null;
}

/** Pure authorization predicate mirroring index.ts logic for updating concern structure. */
export function canUpdateConcernStructure(createdBy: string | undefined, actorUid: string, isAdmin: boolean): boolean {
  if (!actorUid) return false;
  if (createdBy && createdBy === actorUid) return true;
  if (isAdmin) return true;
  return false;
}
