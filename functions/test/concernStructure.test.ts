import { normalizeStringArray, canUpdateConcernStructure } from '../src/concernStructure';

describe('normalizeStringArray', () => {
  it('returns null for non-array input', () => {
    expect(normalizeStringArray(undefined, 5, 50)).toBeNull();
    expect(normalizeStringArray('abc' as any, 5, 50)).toBeNull();
  });
  it('trims, removes empties, enforces max items and length', () => {
    const input = ['  one  ', 'two', ' ', '', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const out = normalizeStringArray(input, 8, 10)!; // limit 8 items, len 10
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('one');
    // Ensure item length capped
    const long = normalizeStringArray(['a'.repeat(25)], 5, 10)!;
    expect(long[0].length).toBe(10);
  });
  it('returns null when all entries blank after trimming', () => {
    expect(normalizeStringArray(['  ',' \n '], 5, 10)).toBeNull();
  });
});

describe('canUpdateConcernStructure', () => {
  it('allows creator', () => {
    expect(canUpdateConcernStructure('u1', 'u1', false)).toBe(true);
  });
  it('allows admin even if not creator', () => {
    expect(canUpdateConcernStructure('u1', 'adminUser', true)).toBe(true);
  });
  it('denies non-creator non-admin', () => {
    expect(canUpdateConcernStructure('u1', 'u2', false)).toBe(false);
  });
  it('denies missing actor uid', () => {
    expect(canUpdateConcernStructure('u1', '' as any, true)).toBe(false); // actorUid required
  });
});
