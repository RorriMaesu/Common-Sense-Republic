import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { app } from './firebaseClientInternal';

// All config resolution happens in firebaseClientInternal (explicit env var -> injected defaults).
// We intentionally avoid re-specifying the config here to prevent copy drift.

if (typeof window !== 'undefined') {
  isSupported().then(ok => { if (ok) try { getAnalytics(app); } catch { /* analytics optional */ } });
}

export const auth = getAuth(app);
export const db = getFirestore(app);

// Local Emulator Connection (configured via .env.local: NEXT_PUBLIC_USE_EMULATORS=true)
if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') {
  // eslint-disable-next-line no-console
  console.log('Using Firebase Emulators (Auth:9099, Firestore:8080)');
  connectAuthEmulator(auth, 'http://localhost:9099');
  connectFirestoreEmulator(db, 'localhost', 8080);
}
