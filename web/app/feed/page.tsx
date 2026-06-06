"use client";
import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, doc, updateDoc, increment } from 'firebase/firestore';
import { db, auth } from '../../lib/firebaseClient';
import Link from 'next/link';

interface Concern { 
  id: string; 
  title: string; 
  description: string; 
  nominationCount?: number;
  createdAt?: any; 
}

export default function FeedPage() {
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [loading, setLoading] = useState(true);
  const [nominatingId, setNominatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchConcerns = async () => {
    try {
      const q = query(collection(db, 'concerns'), orderBy('createdAt', 'desc'), limit(25));
      const snap = await getDocs(q);
      setConcerns(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
    } catch (err: any) {
      console.error("Failed to fetch concerns", err);
    }
  };

  useEffect(() => {
    (async () => {
      await fetchConcerns();
      setLoading(false);
    })();
  }, []);

  const handleNominate = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    const currentUser = auth.currentUser;
    if (!currentUser) {
      setError("You must be signed in to nominate a concern.");
      setTimeout(() => setError(null), 4000);
      return;
    }

    setNominatingId(id);
    try {
      const { doc, setDoc, getDoc, serverTimestamp } = await import('firebase/firestore');
      
      // Enforce sybil-resistance by writing to user-scoped nomination document
      const voteRef = doc(db, 'concerns', id, 'nominations', currentUser.uid);
      const voteSnap = await getDoc(voteRef);
      if (voteSnap.exists()) {
        setError("You have already nominated this concern.");
        setTimeout(() => setError(null), 4500);
        setNominatingId(null);
        return;
      }

      await setDoc(voteRef, {
        voter: currentUser.uid,
        createdAt: serverTimestamp()
      });

      const concernRef = doc(db, 'concerns', id);
      await updateDoc(concernRef, {
        nominationCount: increment(1)
      });
      
      // Update local state count
      setConcerns(prev => prev.map(c => c.id === id ? { ...c, nominationCount: (c.nominationCount || 0) + 1 } : c));
    } catch (err: any) {
      console.error("Failed to nominate concern", err);
    } finally {
      setNominatingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Collective Concern Pool</h1>
          <p className="text-xs text-muted">Review, support, and nominate citizen policy concerns to be synthesized into bills.</p>
        </div>
        <Link href="/concern/new" className="btn-primary text-xs">Create Concern</Link>
      </div>

      {error && (
        <div className="p-3 text-xs bg-red-500/10 text-red-500 rounded-xl border border-red-500/20">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid sm:grid-cols-2 gap-4" aria-live="polite">
          {Array.from({length:4}).map((_,i)=>(
            <div key={i} className="rounded-card h-28 bg-gradient-to-br from-black/5 to-black/10 dark:from-white/5 dark:to-white/10 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && (
        <div className="grid sm:grid-cols-2 gap-4">
          {concerns.map(c => (
            <div key={c.id} className="card p-5 border flex flex-col justify-between hover:shadow-md transition bg-white dark:bg-black/15">
              <Link href={`/concern/${c.id}`} className="space-y-1.5 flex-1 block group">
                <h3 className="font-bold text-sm text-brand-navy dark:text-white group-hover:text-brand-gold transition-colors line-clamp-1">{c.title}</h3>
                <p className="text-[11px] text-muted leading-relaxed line-clamp-3">{c.description}</p>
              </Link>
              <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between">
                <span className="text-[10px] font-bold text-brand-gold bg-brand-gold/10 px-2 py-0.5 rounded-full">
                  ★ {c.nominationCount || 0} Nominations
                </span>
                <button
                  disabled={nominatingId === c.id}
                  onClick={(e) => handleNominate(e, c.id)}
                  className="px-3 py-1 rounded bg-brand-navy hover:bg-brand-navy/90 text-white text-[10px] font-bold transition disabled:opacity-50"
                >
                  {nominatingId === c.id ? 'Nominating...' : 'Nominate Idea'}
                </button>
              </div>
            </div>
          ))}
          {concerns.length === 0 && <p className="text-sm text-muted col-span-full">No concerns have been voiced yet.</p>}
        </div>
      )}
    </div>
  );
}
