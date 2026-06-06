"use client";
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../../../lib/firebaseClient';
import { castVoteSafe, fnTallyBallot, exportBallotReportSafe } from '../../../lib/functionsClient';
import { tallyRCV as clientTallyRCV } from '../../../../packages/shared/tally/rcv';
import { onAuthStateChanged } from 'firebase/auth';

export default function BallotDetail() {
  const { id } = useParams();
  const [ballot, setBallot] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string|undefined>();
  const [receipt, setReceipt] = useState<{ receipt: string; receiptHash: string }|null>(null);
  const [exporting,setExporting] = useState(false);
  const [selection, setSelection] = useState<any>({ choice: '', approvals: new Set<string>(), ranking: [] as string[] });
  const [userTier, setUserTier] = useState<string>('basic');
  const [now, setNow] = useState<number>(Date.now());
  const [verification,setVerification] = useState<{status:'idle'|'verifying'|'matched'|'mismatch'|'error'; detail?:string}>({status:'idle'});
  useEffect(()=> {
    const iv = setInterval(()=> setNow(Date.now()), 1000);
    return ()=> clearInterval(iv);
  },[]);

  useEffect(()=> {
    const unsub = onAuthStateChanged(auth, u=> setUser(u));
    return () => unsub();
  },[]);

  useEffect(()=> { if(!id) return; (async () => {
    const snap = await getDoc(doc(db,'ballots', id as string));
    if (snap.exists()) setBallot(snap.data());
    setLoading(false);
  })(); },[id]);

  // Fetch user tier (lightweight) after auth
  useEffect(()=> { (async () => {
    if (!user) return;
    try {
      const us = await getDoc(doc(db,'users', user.uid));
      if (us.exists()) setUserTier((us.data() as any).tier || 'basic');
    } catch {/* ignore */}
  })(); }, [user]);

  async function submit() {
    if (!ballot) return;
    setSubmitting(true); setMessage(undefined);
    try {
      let payload: any = { ballotId: ballot.ballotId };
      if (ballot.type==='simple') payload.choice = selection.choice;
      else if (ballot.type==='approval') payload.approvals = Array.from(selection.approvals);
      else payload.ranking = selection.ranking;
  const res: any = await castVoteSafe(payload);
  const data = res.data || res; // support both callable & http shapes
  setReceipt({ receipt: data.receipt, receiptHash: data.receiptHash });
  setMessage('Vote submitted. You can copy or download your receipt below.');
    } catch (e: any) { setMessage(e.message || 'Error'); }
    setSubmitting(false);
  }

  async function tally() {
    try { const res: any = await fnTallyBallot({ ballotId: ballot.ballotId }); setMessage('Tallied'); setBallot({...ballot, status:'tallied', results: res.data.results}); } catch (e:any){ setMessage(e.message); }
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (!ballot) return <p className="text-sm text-red-600">Not found.</p>;
  const endMs = ballot?.endAt?.toMillis ? ballot.endAt.toMillis() : (ballot?.endAt?._seconds ? ballot.endAt._seconds*1000 : null);
  const remaining = endMs ? Math.max(0, endMs - now) : 0;
  const closed = ballot.status !== 'open' || remaining === 0;
  const countdown = remaining > 0 ? `${Math.floor(remaining/60000)}m ${Math.floor((remaining%60000)/1000)}s` : 'Ended';
  const eligible = ballot?.minTierRank ? tierRank(userTier) >= ballot.minTierRank : true;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ballot.title || `Ballot ${ballot.ballotId}`}</h1>
        <p className="text-sm text-muted">Type: {ballot.type} · Status: {ballot.status} {ballot.status==='open' && (<span>· Time left: {countdown}</span>)} · Min Tier: {ballot.minTier || 'basic'}</p>
        {!eligible && <p className="text-xs text-red-600 mt-1">Your tier ({userTier}) is below the required tier ({ballot.minTier}). You may view but not vote.</p>}
        {ballot.description && (
          <div className="mt-4 p-4 rounded-xl border bg-gray-50 dark:bg-black/30 text-sm whitespace-pre-wrap leading-relaxed">
            {ballot.description}
          </div>
        )}
      </div>
      {ballot.type==='simple' && (
        <div className="space-y-2">
          {ballot.options.map((o:any)=>(
            <label key={o.id} className="flex items-center gap-3 text-sm p-2 rounded-md border cursor-pointer hover:bg-black/5 dark:hover:bg-white/10 transition">
              <input aria-label={o.label} className="accent-brand-teal" type="radio" name="choice" disabled={closed} checked={selection.choice===o.id} onChange={()=> setSelection({...selection, choice:o.id})} /> <span className="flex-1">{o.label}</span>
            </label>
          ))}
        </div>
      )}
      {ballot.type==='approval' && (
        <div className="space-y-2">
          {ballot.options.map((o:any)=>(
            <label key={o.id} className="flex items-center gap-3 text-sm p-2 rounded-md border cursor-pointer hover:bg-black/5 dark:hover:bg-white/10 transition">
              <input aria-label={o.label} className="accent-brand-teal" type="checkbox" disabled={closed} checked={selection.approvals.has(o.id)} onChange={()=> { const ns = new Set(selection.approvals); ns.has(o.id)?ns.delete(o.id):ns.add(o.id); setSelection({...selection, approvals: ns}); }} /> <span className="flex-1">{o.label}</span>
            </label>
          ))}
        </div>
      )}
      {ballot.type==='rcv' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Click options to add/remove ranking (prototype ranking UI).</p>
          <div className="flex flex-wrap gap-2">
            {ballot.options.map((o:any)=> {
              const ranked = selection.ranking.indexOf(o.id);
              return (
                <button key={o.id} disabled={closed} className={`btn-pill text-xs ${ranked>-1?'btn-pill-active':''}`} onClick={()=> {
                  const r = [...selection.ranking];
                  if (ranked>-1) r.splice(ranked,1); else r.push(o.id);
                  setSelection({...selection, ranking: r});
                }}>{o.label}{ranked>-1?` (${ranked+1})`:''}</button>
              );
            })}
          </div>
        </div>
      )}
  {!closed && eligible && <button disabled={submitting} onClick={submit} className="btn-primary text-sm">{submitting?'Submitting...':'Submit / Update Vote'}</button>}
  {!closed && !eligible && <button disabled className="btn-primary opacity-40 cursor-not-allowed text-sm">Ineligible</button>}
  {closed && !ballot.results && <p className="text-xs text-muted">Ballot ended. Waiting for tally.</p>}
      {user && ballot.createdBy===user.uid && ballot.status!=='tallied' && <button onClick={tally} className="ml-3 px-3 py-2 border rounded text-xs">Tally Now</button>}
  {message && <p className="text-xs text-muted">{message}</p>}
  {receipt && (
        <div className="border rounded p-2 bg-black/20 space-y-1 max-w-md">
          <p className="text-[11px]">Receipt: <span className="font-mono select-all">{receipt.receipt}</span></p>
          <p className="text-[10px] text-muted">Hash: {receipt.receiptHash}</p>
          <button onClick={()=> {
            const blob = new Blob([JSON.stringify({ ballotId: ballot.ballotId, receipt: receipt.receipt, receiptHash: receipt.receiptHash, ts: Date.now() }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `wevote_receipt_${ballot.ballotId}.json`; a.click(); setTimeout(()=> URL.revokeObjectURL(url), 2000);
          }} className="text-[11px] underline">Download JSON</button>
        </div>
      )}
      {ballot.results && (
        <div className="card text-xs space-y-2">
          <h2 className="font-semibold">Results</h2>
          {ballot.tallySignature && (
            <p className="text-[10px] text-green-600">Signed tally (KMS): {ballot.tallySignature.signatureBase64?.slice(0,16)}…</p>
          )}
          {ballot.type!=='rcv' && (
            <ul className="list-disc ml-4">
              {Object.entries(ballot.results.counts||{}).map(([k,v]:any)=>(<li key={k}>{k}: {v}</li>))}
            </ul>
          )}
          {ballot.type==='rcv' && (
            <div className="space-y-2">
              {(ballot.results.rounds||[]).map((r:any)=>(
                <div key={r.round} className="border p-2 rounded">
                  <p>Round {r.round} {r.eliminated && `— Eliminated ${r.eliminated}`}</p>
                  <ul className="list-disc ml-4">
                    {Object.entries(r.counts).map(([k,v]:any)=>(<li key={k}>{k}: {v}</li>))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="font-medium">Winner: {ballot.results.winner || '—'}</p>
          <button disabled={exporting} onClick={async ()=> {
            setExporting(true); try {
              const bundle = await exportBallotReportSafe(ballot.ballotId);
              const blob = new Blob([JSON.stringify(bundle,null,2)], { type:'application/json' });
              const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=`wevote_audit_${ballot.ballotId}.json`; a.click(); setTimeout(()=> URL.revokeObjectURL(url),1500);
            } catch(e:any) { setMessage(e.message||'Export failed'); } setExporting(false);
          }} className="px-3 py-2 border rounded text-[11px]">{exporting? 'Exporting…':'Download Audit Bundle'}</button>
          <div className="space-y-1">
            {ballot.tallyHash && <p className="text-[10px] text-muted">Tally Hash: <span className="font-mono">{ballot.tallyHash.slice(0,16)}…</span></p>}
            <button disabled={verification.status==='verifying'} onClick={async ()=> {
              setVerification({status:'verifying'});
              try {
                const bundle:any = await exportBallotReportSafe(ballot.ballotId);
                const original = ballot.results;
                let winnerMatch = false; let structureMatch = false;
                if (ballot.type==='rcv') {
                  const rankings = (bundle.votes||[]).map((v:any)=> ({ ranking: Array.isArray(v.ranking)? v.ranking : [] }));
                  const recomputed = clientTallyRCV(rankings);
                  winnerMatch = recomputed.winner === original.winner;
                  structureMatch = JSON.stringify(recomputed.rounds) === JSON.stringify(original.rounds);
                } else if (ballot.type==='simple') {
                  const counts: Record<string,number> = {};
                  ballot.options.forEach((o:any)=> counts[o.id]=0);
                  (bundle.votes||[]).forEach((v:any)=> { if (v.choice && counts.hasOwnProperty(v.choice)) counts[v.choice]++; });
                  winnerMatch = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] === original.winner;
                  structureMatch = JSON.stringify(counts) === JSON.stringify(original.counts||original.counts); // counts only
                } else if (ballot.type==='approval') {
                  const counts: Record<string,number> = {};
                  ballot.options.forEach((o:any)=> counts[o.id]=0);
                  (bundle.votes||[]).forEach((v:any)=> (v.approvals||[]).forEach((id:string)=> { if (counts.hasOwnProperty(id)) counts[id]++; }));
                  winnerMatch = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] === original.winner;
                  structureMatch = JSON.stringify(counts) === JSON.stringify(original.counts||original.counts);
                }
                if (winnerMatch && structureMatch) setVerification({status:'matched'});
                else setVerification({status:'mismatch', detail:`Winner match: ${winnerMatch}; Structure match: ${structureMatch}`});
              } catch (e:any) { setVerification({status:'error', detail: e.message||'Verification failed'}); }
            }} className="px-3 py-2 border rounded text-[11px]">{verification.status==='verifying'?'Verifying…':'Verify Tally Locally'}</button>
            {verification.status==='matched' && <p className="text-[10px] text-green-600">Local recompute matches ✅</p>}
            {verification.status==='mismatch' && <p className="text-[10px] text-red-600">Mismatch: {verification.detail}</p>}
            {verification.status==='error' && <p className="text-[10px] text-yellow-600">Error: {verification.detail}</p>}
          </div>
        </div>
      )}

      {/* Discussion Forum / Comment Thread Section */}
      <BallotDiscussionSection ballotId={ballot.ballotId} user={user} />
    </div>
  );
}

interface Comment { id: string; authorEmail: string; text: string; createdAt: any; }

function BallotDiscussionSection({ ballotId, user }: { ballotId: string; user: any }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadComments() {
    try {
      const { collection, getDocs, query, orderBy, limit } = await import('firebase/firestore');
      const q = query(
        collection(db, 'ballots', ballotId, 'comments'),
        orderBy('createdAt', 'asc'),
        limit(100)
      );
      const snap = await getDocs(q);
      setComments(snap.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) })));
    } catch (err) {
      console.error('Failed to load comments:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ballotId) {
      loadComments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ballotId]);

  async function postComment() {
    if (!commentText.trim() || !user) return;
    try {
      const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
      await addDoc(collection(db, 'ballots', ballotId, 'comments'), {
        authorEmail: user.email || 'Anonymous',
        authorUid: user.uid,
        text: commentText.trim(),
        createdAt: serverTimestamp()
      });
      setCommentText('');
      await loadComments();
    } catch (err) {
      console.error('Failed to post comment:', err);
    }
  }

  return (
    <div className="border-t pt-6 space-y-4">
      <h3 className="text-lg font-semibold tracking-tight">Ballot Debate & Discussion</h3>
      {loading ? (
        <p className="text-xs text-muted">Loading debate comments...</p>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
          {comments.map(c => (
            <div key={c.id} className="p-3 bg-surface border rounded-xl text-xs space-y-1">
              <div className="flex justify-between font-bold text-muted text-[10px]">
                <span>{c.authorEmail}</span>
                <span>{c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString() : 'Just now'}</span>
              </div>
              <p className="text-sm">{c.text}</p>
            </div>
          ))}
          {comments.length === 0 && (
            <p className="text-xs text-muted py-2">No discussion has started yet. Be the first to share your stance!</p>
          )}
        </div>
      )}

      {user ? (
        <div className="flex gap-2">
          <input
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            placeholder="Share your thoughts or policy stance..."
            className="input flex-1 text-xs"
            onKeyDown={e => e.key === 'Enter' && postComment()}
          />
          <button onClick={postComment} disabled={!commentText.trim()} className="btn-primary text-xs px-4">
            Post
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted text-center py-2">Sign in to join the debate.</p>
      )}
    </div>
  );
}

function tierRank(tier?: string) {
  switch ((tier||'').toLowerCase()) {
    case 'basic': return 1;
    case 'verified': return 2;
    case 'expert': return 3;
    case 'admin': return 4;
    default: return 0;
  }
}
