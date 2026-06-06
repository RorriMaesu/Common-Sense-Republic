"use client";
import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../../../lib/firebaseClient';
import { synthesizeConcernsToBill } from '../../../lib/billDrafter';
import { LocalLlmRouter } from '../../../lib/localLlmRouter';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Concern {
  id: string;
  title: string;
  description: string;
  nominationCount?: number;
  createdAt?: any;
}

export default function DraftingDashboard() {
  const router = useRouter();
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [progressStatus, setProgressStatus] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [draftedText, setDraftedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdBallotId, setCreatedBallotId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const q = query(collection(db, 'concerns'), orderBy('nominationCount', 'desc'), limit(50));
        const snap = await getDocs(q);
        setConcerns(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      } catch (err: any) {
        console.error("Failed to load concerns", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleDraftProposal = async () => {
    if (selectedIds.length === 0) {
      setError("Please select at least one concern to compile.");
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      setError("You must be signed in as an administrator to run drafting.");
      return;
    }

    setError(null);
    setDrafting(true);
    setProgressPercent(0);
    setProgressStatus("Preparing context...");
    setDraftedText('');

    try {
      // 1. Synthesize the selected concerns into a markdown proposal
      const result = await synthesizeConcernsToBill(selectedIds, {
        streamCallback: (token, full) => {
          setDraftedText(full);
        },
        progressCallback: (stage, percent) => {
          setProgressStatus(stage);
          setProgressPercent(percent);
        }
      });

      // 2. Create the Ballot document in Firestore directly under the administrator credentials
      setProgressStatus("Publishing Ballot to Open Forums...");
      setProgressPercent(95);

      const ballotRef = doc(collection(db, 'ballots'));
      const selectedTitles = concerns
        .filter(c => selectedIds.includes(c.id))
        .map(c => c.title);

      await setDoc(ballotRef, {
        ballotId: ballotRef.id,
        concernId: selectedIds[0],
        draftId: result.draftId,
        title: result.title || `Collective Bill: ${selectedTitles.slice(0,2).join(', ')}`,
        description: result.text,
        type: 'simple',
        options: [
          { id: 'yes', label: 'Yes, pass this bill proposal' },
          { id: 'no', label: 'No, reject this bill proposal' }
        ],
        status: 'open',
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 1 week
      });

      setProgressStatus("Ballot published successfully!");
      setProgressPercent(100);
      setCreatedBallotId(ballotRef.id);
    } catch (err: any) {
      setError(err.message || "Drafting synthesis failed. Please ensure your local model is online.");
      setDrafting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Collective Legislative Drafting</h1>
        <p className="text-xs text-muted">Select user concerns from the community pool and use the local AI to draft a fair, balanced legislative proposal.</p>
      </div>

      {error && (
        <div className="p-3 text-xs bg-red-500/10 text-red-500 rounded-xl border border-red-500/20">
          {error}
        </div>
      )}

      {createdBallotId && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl space-y-3">
          <p className="text-xs text-emerald-600 font-semibold">✓ Draft Bill synthesized and Ballot published successfully!</p>
          <div className="flex gap-3">
            <Link href={`/ballot/${createdBallotId}`} className="btn-primary text-xs px-4 py-2">
              Go to Ballot Room
            </Link>
            <button 
              onClick={() => {
                setCreatedBallotId(null);
                setDrafting(false);
                setSelectedIds([]);
              }} 
              className="btn-secondary text-xs px-4 py-2"
            >
              Draft Another
            </button>
          </div>
        </div>
      )}

      {!drafting && !createdBallotId && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">
              {selectedIds.length} concerns selected
            </span>
            <button
              onClick={handleDraftProposal}
              disabled={selectedIds.length === 0}
              className="btn-primary text-xs px-4 py-2 disabled:opacity-50"
            >
              Compile & Draft Bill
            </button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl bg-black/5 dark:bg-white/5 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
              {concerns.map(c => (
                <label 
                  key={c.id} 
                  className={`flex items-start gap-4 p-4 border rounded-2xl cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-all ${
                    selectedIds.includes(c.id) ? 'border-brand-gold bg-brand-gold/5' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(c.id)}
                    onChange={() => handleToggleSelect(c.id)}
                    className="mt-1 accent-brand-gold"
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex justify-between items-start gap-2">
                      <h3 className="font-bold text-sm leading-none">{c.title}</h3>
                      <span className="text-[10px] font-bold text-brand-gold shrink-0">
                        ★ {c.nominationCount || 0} nominations
                      </span>
                    </div>
                    <p className="text-[11px] text-muted line-clamp-2 leading-relaxed">{c.description}</p>
                  </div>
                </label>
              ))}
              {concerns.length === 0 && (
                <p className="text-sm text-muted text-center py-6">No concerns available in the pool yet.</p>
              )}
            </div>
          )}
        </>
      )}

      {drafting && !createdBallotId && (
        <div className="border rounded-2xl p-6 bg-white dark:bg-black/10 shadow-sm space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-brand-navy dark:text-white">AI Drafting Engine Status:</h3>
            <p className="text-xs text-muted font-mono">{progressStatus}</p>
            <div className="w-full bg-border rounded-full h-2 overflow-hidden">
              <div 
                className="bg-brand-gold h-2 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {draftedText && (
            <div className="space-y-2 pt-2 border-t">
              <h4 className="text-xs font-bold text-muted uppercase">Drafting Output:</h4>
              <div className="p-4 bg-gray-50 dark:bg-black/35 rounded-xl border font-mono text-xs whitespace-pre-wrap max-h-[30vh] overflow-y-auto">
                {draftedText}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
