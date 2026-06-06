"use client";
import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, where } from 'firebase/firestore';
import { db } from '../../lib/firebaseClient';
import Link from 'next/link';

interface Ballot { id: string; title: string; description: string; pinnedWeek?: any; createdAt?: any; }

export default function ForumsPage() {
  const [pinnedBallots, setPinnedBallots] = useState<Ballot[]>([]);
  const [recentBallots, setRecentBallots] = useState<Ballot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Fetch pinned ballots
        const pinnedQ = query(collection(db, 'ballots'), orderBy('pinnedWeek', 'desc'), limit(5));
        const pinnedSnap = await getDocs(pinnedQ);
        const pinned = pinnedSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setPinnedBallots(pinned);

        // Fetch recent ballots
        const recentQ = query(collection(db, 'ballots'), orderBy('createdAt', 'desc'), limit(20));
        const recentSnap = await getDocs(recentQ);
        const recent = recentSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        
        // Filter out pinned from recent
        const pinnedIds = new Set(pinned.map(b => b.id));
        setRecentBallots(recent.filter(b => !pinnedIds.has(b.id)));
      } catch (e) {
        console.error("Failed to fetch forums", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight">Open Forums</h1>
        <Link href="/concern/new" className="btn-primary text-sm">Draft New Bill</Link>
      </div>

      {loading ? (
        <div className="space-y-4" aria-live="polite">
          {Array.from({length:3}).map((_,i)=>(
            <div key={i} className="rounded-card h-32 bg-gradient-to-br from-black/5 to-black/10 dark:from-white/5 dark:to-white/10 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {pinnedBallots.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                <span className="text-brand-gold">★</span> Top Bills This Week
              </h2>
              <div className="grid gap-4">
                {pinnedBallots.map(b => (
                  <Link key={b.id} href={`/ballot/${b.id}`} className="card border-brand-gold/50 hover:shadow-md hover:translate-y-[-2px] transition block bg-brand-gold/5">
                    <h3 className="font-bold mb-2 text-lg">{b.title}</h3>
                    <p className="text-sm text-muted line-clamp-3 leading-relaxed">{b.description}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-lg font-semibold mb-4">Recent Bills</h2>
            <div className="grid gap-4">
              {recentBallots.map(b => (
                <Link key={b.id} href={`/ballot/${b.id}`} className="card hover:shadow-md hover:translate-y-[-2px] transition block">
                  <h3 className="font-medium mb-1 text-base">{b.title}</h3>
                  <p className="text-sm text-muted line-clamp-2 leading-relaxed">{b.description}</p>
                </Link>
              ))}
              {recentBallots.length === 0 && pinnedBallots.length === 0 && (
                <p className="text-sm text-muted">No bills available yet.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
