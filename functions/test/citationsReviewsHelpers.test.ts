import { mergeCitations, canAddReview, computeReputationIncrementForReview } from '../src/index';

describe('mergeCitations helper', () => {
  it('deduplicates by docId+url and enforces max size', () => {
    const existing = [
      { docId: 'd1', url: 'https://a.example/x', excerpt: 'A' },
      { docId: 'd2', url: 'https://b.example/y', excerpt: 'B' }
    ];
    const incoming = [
      { docId: 'd1', url: 'https://a.example/x', excerpt: 'A2' }, // duplicate pair should overwrite
      { docId: 'd3', url: 'https://c.example/z', excerpt: 'C' }
    ];
    const merged = mergeCitations(existing, incoming, 10);
    // d1 should appear once with last normalized value
    const d1s = merged.filter(c => c.docId === 'd1');
    expect(d1s).toHaveLength(1);
    expect(merged.map(c => c.docId).sort()).toEqual(['d1','d2','d3']);
  });

  it('caps output length at max', () => {
    const many = Array.from({ length: 40 }).map((_,i) => ({ docId: 'x'+i, url: 'https://e.example/'+i }));
    const merged = mergeCitations([], many, 25);
    expect(merged).toHaveLength(25);
  });
});

describe('canAddReview predicate', () => {
  it('prevents duplicate review of same kind by same user', () => {
    const existing = [ { uid: 'u1', role: 'expert', kind: 'legal', signedAt: Date.now() } as any ];
    expect(canAddReview(existing, 'u1', 'legal')).toBe(false);
    expect(canAddReview(existing, 'u1', 'fact')).toBe(true); // different kind allowed
    expect(canAddReview(existing, 'u2', 'legal')).toBe(true); // different user allowed
  });
});

describe('computeReputationIncrementForReview', () => {
  it('returns 1 for legal/fact/expert kinds', () => {
    expect(computeReputationIncrementForReview('legal')).toBe(1);
    expect(computeReputationIncrementForReview('fact')).toBe(1);
    expect(computeReputationIncrementForReview('expert')).toBe(1);
  });
  it('returns 0 for unknown kinds', () => {
    expect(computeReputationIncrementForReview('other')).toBe(0);
  });
});
