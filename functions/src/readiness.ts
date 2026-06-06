import * as admin from 'firebase-admin';

/**
 * Concern readiness scoring helper (pure logic except Firestore fetch wrapper below when used directly).
 * Inputs are metrics derived from drafts & concern context.
 */
export interface ReadinessMetrics {
  draftCount: number;
  expertReviewCount: number; // reviews with kind in ['expert','fact','legal'] AND role expert|admin
  totalReviewCount: number;
  citationsCount: number; // aggregate citations across drafts (dedup not enforced here)
  distinctiveness: number; // 0..1 measure of option uniqueness (avg pairwise distance)
  hasSummaryFields: boolean; // future use (objectives/constraints etc.)
}

export interface ReadinessResult {
  score: number; // 0..100
  components: Record<string, number>;
  missing: string[];
  recommendations: string[];
  version: number;
}

export function computeConcernReadiness(m: ReadinessMetrics): ReadinessResult {
  // Component weights (tunable): drafts 30, expert review 30, citations 15, distinctiveness 20, summary fields 5
  const weights = { drafts: 30, expert: 30, citations: 15, distinct: 20, summary: 5 };
  const draftScore = Math.min(1, m.draftCount / 3); // full credit at 3 drafts
  const expertScore = Math.min(1, m.expertReviewCount / 1); // at least one expert/fact/legal review
  const citationsScore = Math.min(1, m.citationsCount / 2); // full credit at 2+ citations
  const distinctScore = m.distinctiveness; // already normalized 0..1
  const summaryScore = m.hasSummaryFields ? 1 : 0;
  const total = (
    draftScore * weights.drafts +
    expertScore * weights.expert +
    citationsScore * weights.citations +
    distinctScore * weights.distinct +
    summaryScore * weights.summary
  );
  const max = Object.values(weights).reduce((a,b)=>a+b,0);
  const score = Math.round((total / max) * 100);

  const missing: string[] = [];
  if (m.draftCount < 2) missing.push('more_drafts');
  if (m.expertReviewCount < 1) missing.push('expert_review');
  if (m.citationsCount < 1) missing.push('citations');
  if (m.distinctiveness < 0.45) missing.push('distinctiveness');
  if (!m.hasSummaryFields) missing.push('summary_fields');

  const recommendations: string[] = [];
  if (missing.includes('more_drafts')) recommendations.push('Generate at least one more distinct draft option.');
  if (missing.includes('expert_review')) recommendations.push('Request an expert, fact, or legal review for one draft.');
  if (missing.includes('citations')) recommendations.push('Add at least one supporting citation to any draft.');
  if (missing.includes('distinctiveness')) recommendations.push('Refine or regenerate drafts to ensure they differ in approach, not just wording.');
  if (missing.includes('summary_fields')) recommendations.push('Summarize objectives & constraints (use assistant to structure these).');

  return {
    score,
    components: {
      drafts: Math.round(draftScore * 100),
      expert: Math.round(expertScore * 100),
      citations: Math.round(citationsScore * 100),
      distinct: Math.round(distinctScore * 100),
      summary: Math.round(summaryScore * 100)
    },
    missing,
    recommendations,
    version: 1
  };
}

/** Compute a crude distinctiveness metric (0..1) using pairwise token Jaccard distance. */
export function computeDistinctiveness(texts: string[]): number {
  if (texts.length < 2) return 0; // need at least 2 to compare
  const norm = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(w=>w.length>2).slice(0,400));
  const sets = texts.map(norm);
  let sum = 0; let pairs = 0;
  for (let i=0;i<sets.length;i++) {
    for (let j=i+1;j<sets.length;j++) {
      pairs++;
      const a = sets[i]; const b = sets[j];
      const inter = [...a].filter(x=>b.has(x)).length;
      const union = a.size + b.size - inter || 1;
      const jaccard = inter / union;
      const distance = 1 - jaccard; // distance higher == more distinct
      sum += distance;
    }
  }
  return sum / pairs;
}

/** Firestore loader to gather metrics and return readiness result */
export async function evaluateConcernReadiness(concernId: string): Promise<ReadinessResult> {
  const db = admin.firestore();
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  if (!concernSnap.exists) throw new Error('concern_not_found');
  const concern = concernSnap.data() as any;
  // Drafts
  const draftsSnap = await db.collection('drafts').where('concernId','==', concernId).limit(20).get();
  const drafts = draftsSnap.docs.map(d=> d.data() as any);
  const draftCount = drafts.length;
  let expertReviewCount = 0; let totalReviewCount = 0; let citationsCount = 0;
  const draftTexts: string[] = [];
  drafts.forEach(d => {
    const reviews: any[] = d.reviews || [];
    totalReviewCount += reviews.length;
    expertReviewCount += reviews.filter(r=> ['expert','admin'].includes((r.role||'').toLowerCase()) && ['expert','fact','legal'].includes(r.kind)).length;
    citationsCount += (d.citations || []).length;
    if (d.text) draftTexts.push(String(d.text));
  });
  const distinctiveness = computeDistinctiveness(draftTexts.slice(0,6));
  const hasSummaryFields = !!(concern.objectives?.length || concern.constraints?.length || concern.openQuestions?.length);
  return computeConcernReadiness({ draftCount, expertReviewCount, totalReviewCount, citationsCount, distinctiveness, hasSummaryFields });
}
