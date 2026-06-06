import { computeConcernReadiness, computeDistinctiveness } from '../src/readiness';

describe('readiness scoring', () => {
  test('empty metrics yields low score and multiple missing flags', () => {
    const r = computeConcernReadiness({
      draftCount: 0,
      expertReviewCount: 0,
      totalReviewCount: 0,
      citationsCount: 0,
      distinctiveness: 0,
      hasSummaryFields: false
    });
    expect(r.score).toBeLessThan(10);
    expect(r.missing).toEqual(expect.arrayContaining(['more_drafts','expert_review','citations','distinctiveness','summary_fields']));
  });

  test('full metrics produce high score', () => {
    const r = computeConcernReadiness({
      draftCount: 3,
      expertReviewCount: 1,
      totalReviewCount: 2,
      citationsCount: 3,
      distinctiveness: 0.8,
      hasSummaryFields: true
    });
    expect(r.score).toBeGreaterThan(85);
    expect(r.missing.length).toBe(0);
  });

  test('distinctiveness metric ranges between 0 and 1', () => {
    const dLow = computeDistinctiveness(['same phrase here', 'same phrase here']);
    const dHigh = computeDistinctiveness(['energy policy regulation', 'agricultural water subsidy']);
    expect(dLow).toBeCloseTo(0, 1);
    expect(dHigh).toBeGreaterThan(dLow);
    expect(dHigh).toBeLessThanOrEqual(1);
  });

  test('summary fields presence impacts score component', () => {
    const base = {
      draftCount: 3,
      expertReviewCount: 1,
      totalReviewCount: 2,
      citationsCount: 2,
      distinctiveness: 0.7,
      hasSummaryFields: false
    };
    const without = computeConcernReadiness(base);
    const withSummary = computeConcernReadiness({ ...base, hasSummaryFields: true });
    expect(withSummary.components.summary).toBe(100);
    expect(without.components.summary).toBe(0);
    // Weight for summary is 5/100, so score difference should be close to 5 points.
    expect(withSummary.score - without.score).toBeGreaterThanOrEqual(4); // allow rounding variance
  });
});
