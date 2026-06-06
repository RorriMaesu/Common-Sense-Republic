"use client";
import { useEffect, useState } from 'react';
import { auth, db } from '../../lib/firebaseClient';
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function AuthPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        const ref = doc(db, 'users', u.uid);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, { uid: u.uid, displayName: u.displayName || 'User', identityTier: 'basic', joinedAt: serverTimestamp(), lastActiveAt: serverTimestamp() });
        }
      }
    });
    return () => unsub();
  }, []);

  async function signIn() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }
  async function doSignOut() { await signOut(auth); }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (!user) return (
    <div className="max-w-sm mx-auto card space-y-4">
      <h1 className="text-lg font-semibold">Sign In</h1>
      <button onClick={signIn} className="btn-primary w-full">Continue with Google</button>
  <p className="text-[11px] text-muted">By signing in you accept the advisory nature of Common Sense Republic.</p>
    </div>
  );
  return (
    <div className="max-w-sm mx-auto card space-y-4">
      <p className="text-sm">Signed in as <span className="font-medium">{user.displayName}</span></p>
      <button onClick={doSignOut} className="px-3 py-2 text-sm rounded border">Sign Out</button>
    </div>
  );
}
