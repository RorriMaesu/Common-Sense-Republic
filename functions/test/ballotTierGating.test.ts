// Logical unit tests for server-side ballot creation tier gating
// We mirror the tierRank ordering from index.ts
const TIER_ORDER = ['basic','verified','expert','admin'] as const;
function tierRank(t: string) { const idx = TIER_ORDER.indexOf(t as any); return idx === -1 ? 0 : idx + 1; }

// canCreateBallot: user must be at least verified and >= minTier of ballot
function canCreateBallot(userTier: string, minTier: string) {
  const userRank = tierRank(userTier);
  if (userRank < tierRank('verified')) return false;
  if (userRank < tierRank(minTier)) return false;
  return true;
}

describe('Ballot tier gating logic', () => {
  it('blocks basic creating ballot even if minTier basic', () => {
    expect(canCreateBallot('basic','basic')).toBe(false);
  });
  it('allows verified creating basic ballot', () => {
    expect(canCreateBallot('verified','basic')).toBe(true);
  });
  it('blocks verified creating expert ballot', () => {
    expect(canCreateBallot('verified','expert')).toBe(false);
  });
  it('allows admin creating expert ballot', () => {
    expect(canCreateBallot('admin','expert')).toBe(true);
  });
});
