export interface RCVBallot { ranking: string[]; weight?: number; }
export interface RCVRoundResult { round: number; counts: Record<string, number>; eliminated?: string; exhausted: number; }
export interface RCVOutcome { rounds: RCVRoundResult[]; winner: string | null; exhausted: number; }

export function tallyRCV(ballots: RCVBallot[], tieBreakerPriorities?: string[]): RCVOutcome {
  const rounds: RCVRoundResult[] = [];
  const allCandidates = Array.from(new Set(ballots.flatMap(b => b.ranking)));
  let active = new Set(allCandidates);
  let currentBallots = ballots.map(b => ({ ranking: [...b.ranking], weight: typeof b.weight === 'number' ? b.weight : 1 }));
  let round = 1;
  while (active.size > 0 && round <= 20) {
    const counts: Record<string, number> = {};
    let exhausted = 0;
    for (const cand of active) counts[cand] = 0;
    currentBallots.forEach(rb => {
      while (rb.ranking.length && !active.has(rb.ranking[0])) rb.ranking.shift();
      if (!rb.ranking.length) { exhausted += rb.weight; return; }
      counts[rb.ranking[0]] += rb.weight;
    });
    const totalValid = Object.values(counts).reduce((a,b)=>a+b,0);
    const majority = totalValid/2;
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    if (sorted[0] && sorted[0][1] > majority) {
      rounds.push({ round, counts, exhausted });
      return { rounds, winner: sorted[0][0], exhausted };
    }
    const lowestCount = Math.min(...Object.values(counts));
    const lowestCandidates = Object.entries(counts).filter(([,c])=>c===lowestCount).map(([c])=>c);
    
    if (tieBreakerPriorities && tieBreakerPriorities.length) {
      lowestCandidates.sort((a, b) => {
        const idxA = tieBreakerPriorities.indexOf(a);
        const idxB = tieBreakerPriorities.indexOf(b);
        return idxA - idxB;
      });
    } else {
      // Deterministic selection based on candidate name hashing to prevent name-ordering bias
      const hashString = (str: string) => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i);
          hash |= 0;
        }
        return hash;
      };
      lowestCandidates.sort((a, b) => hashString(a) - hashString(b));
    }
    const eliminated = lowestCandidates[lowestCandidates.length - 1];
    active.delete(eliminated);
    rounds.push({ round, counts, eliminated, exhausted });
    if (active.size === 1) {
      const winner = Array.from(active)[0];
      return { rounds, winner, exhausted };
    }
    round++;
  }
  return { rounds, winner: null, exhausted: 0 };
}
