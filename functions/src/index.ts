import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import 'dotenv/config';
import fetch from 'cross-fetch';
import { createHash, createHmac } from 'crypto';
// Local RCV tally logic (vendored to avoid packaging complexity)
import { tallyRCV } from './rcv';
import { logEvent, kmsSign } from './audit';
import { getGeminiSettings, getReceiptSecret } from './runtimeConfig';
import { buildDraftOptionsPrompt, buildConcernChatPrompt, buildConcernSummaryPrompt } from './prompts';
import { listPromptLibrary } from './prompts';
import { moderateAssistantReply } from './moderation';
import { partitionForSummary, buildRollingSummary } from './summarizer';
import { parseActionSuggestions, estimateTokens } from './actions';
import { buildCanonical } from './ledger';
import { evaluateConcernReadiness } from './readiness';
import { normalizeStringArray } from './concernStructure';
import { runGeminiRepresentative } from './representative';
import { runDailyAggregation } from './aggregation';
import { runAgenticDrafter } from './drafter';
import { runWeeklyPinning } from './forums';

if (!admin.apps.length) {
  admin.initializeApp();
}

// Extracted rate limit helper for draft generation (testable)
export async function applyDraftRateLimit(db: FirebaseFirestore.Firestore, uid: string) {
  const rlRef = db.collection('rate_limits').doc(`drafts_${uid}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000; // 1 hour
    let count = 0; let since = now;
    if (snap.exists) {
      const data = snap.data() as any;
      count = data.count || 0;
      since = data.since || now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 10) {
        throw new functions.https.HttpsError('resource-exhausted', 'Draft generation rate limit exceeded');
      }
    }
    tx.set(rlRef, { count: count + 1, since }, { merge: true });
  });
}

// Rate limit ballot creation: max 3 per user per 6 hours
async function applyBallotCreateRateLimit(db: FirebaseFirestore.Firestore, uid: string) {
  const rlRef = db.collection('rate_limits').doc(`ballots_${uid}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 6 * 60 * 60 * 1000; // 6 hours
    let count = 0; let since = now;
    if (snap.exists) {
      const data = snap.data() as any;
      count = data.count || 0; since = data.since || now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 3) throw new functions.https.HttpsError('resource-exhausted','Ballot creation rate limit exceeded');
    }
    tx.set(rlRef, { count: count + 1, since }, { merge: true });
  });
}

// Rate limit vote submissions per ballot per user: max 10 updates per ballot per hour (prevents spam updates)
async function applyVoteRateLimit(db: FirebaseFirestore.Firestore, uid: string, ballotId: string) {
  const voterHash = createHash('sha256').update(uid + ballotId).digest('hex');
  const rlRef = db.collection('rate_limits').doc(`votes_${voterHash}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    let count = 0; let since = now;
    if (snap.exists) {
      const data = snap.data() as any;
      count = data.count || 0; since = data.since || now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 10) throw new functions.https.HttpsError('resource-exhausted','Too many vote updates; wait before changing again');
    }
    tx.set(rlRef, { count: count + 1, since }, { merge: true });
  });
}

// Moderation report rate limit: max 5 reports per user per hour, and max 2 reports for same target per user per hour
export async function applyModerationRateLimit(db: FirebaseFirestore.Firestore, uid: string, targetRef: string) {
  const globalRef = db.collection('rate_limits').doc(`mod_global_${uid}`);
  const targetKey = targetRef.replace(/\//g,'__');
  const targetRefDoc = db.collection('rate_limits').doc(`mod_target_${uid}_${targetKey}`);
  const now = Date.now();
  const windowStart = now - 60*60*1000;
  await db.runTransaction(async tx => {
    const [gSnap, tSnap] = await Promise.all([tx.get(globalRef), tx.get(targetRefDoc)]);
    const check = (snap: FirebaseFirestore.DocumentSnapshot, limit: number) => {
      let count = 0; let since = now;
      if (snap.exists) {
        const data = snap.data() as any; count = data.count||0; since = data.since||now; if (since < windowStart) { count = 0; since = now; }
        if (count >= limit) return { count, since, blocked: true };
      }
      return { count, since, blocked: false };
    };
    const g = check(gSnap, 5); const t = check(tSnap, 2);
    if (g.blocked || t.blocked) throw new functions.https.HttpsError('resource-exhausted','Too many reports; please wait');
    tx.set(globalRef, { count: g.count + 1, since: g.since < windowStart ? now : g.since }, { merge: true });
    tx.set(targetRefDoc, { count: t.count + 1, since: t.since < windowStart ? now : t.since }, { merge: true });
  });
}

// Citation rate limits: max 20 citation append operations per user per hour globally, max 5 per draft per hour
export async function applyCitationRateLimit(db: FirebaseFirestore.Firestore, uid: string, draftId: string) {
  const globalRef = db.collection('rate_limits').doc(`cite_global_${uid}`);
  const draftRef = db.collection('rate_limits').doc(`cite_${uid}_${draftId}`);
  const now = Date.now();
  const windowStart = now - 60*60*1000;
  await db.runTransaction(async tx => {
    const [gSnap,dSnap] = await Promise.all([tx.get(globalRef), tx.get(draftRef)]);
    const evalSnap = (snap: FirebaseFirestore.DocumentSnapshot, limit: number) => {
      let count = 0; let since = now;
      if (snap.exists) { const data = snap.data() as any; count = data.count||0; since = data.since||now; if (since < windowStart) { count = 0; since = now; } if (count >= limit) return {blocked:true,count,since}; }
      return {blocked:false,count,since};
    };
    const g = evalSnap(gSnap, 20); const d = evalSnap(dSnap, 5);
    if (g.blocked || d.blocked) throw new functions.https.HttpsError('resource-exhausted','Citation rate limit');
    tx.set(globalRef, { count: g.count+1, since: g.since }, { merge: true });
    tx.set(draftRef, { count: d.count+1, since: d.since }, { merge: true });
  });
}

// Review rate limits: max 10 reviews per user per hour, max 2 reviews per draft per user per hour
export async function applyReviewRateLimit(db: FirebaseFirestore.Firestore, uid: string, draftId: string) {
  const globalRef = db.collection('rate_limits').doc(`rev_global_${uid}`);
  const draftRef = db.collection('rate_limits').doc(`rev_${uid}_${draftId}`);
  const now = Date.now();
  const windowStart = now - 60*60*1000;
  await db.runTransaction(async tx => {
    const [gSnap,dSnap] = await Promise.all([tx.get(globalRef), tx.get(draftRef)]);
    const evalSnap = (snap: FirebaseFirestore.DocumentSnapshot, limit: number) => {
      let count = 0; let since = now;
      if (snap.exists) { const data = snap.data() as any; count = data.count||0; since = data.since||now; if (since < windowStart) { count = 0; since = now; } if (count >= limit) return {blocked:true,count,since}; }
      return {blocked:false,count,since};
    };
    const g = evalSnap(gSnap, 10); const d = evalSnap(dSnap, 2);
    if (g.blocked || d.blocked) throw new functions.https.HttpsError('resource-exhausted','Review rate limit');
    tx.set(globalRef, { count: g.count+1, since: g.since }, { merge: true });
    tx.set(draftRef, { count: d.count+1, since: d.since }, { merge: true });
  });
}

// Use a single region to minimize cold starts / cost surface
const r = functions.region('us-central1');

// Allowed Gemini model variants (update as Google model catalog evolves)
const ALLOWED_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro'
]);

// Map user tier -> default model (cheapest adequate for tier)
const TIER_DEFAULT_MODEL: Record<string,string> = {
  basic: 'gemini-3-flash-preview',
  verified: 'gemini-3-flash-preview',
  expert: 'gemini-2.5-pro',
  admin: 'gemini-2.5-pro'
};

// Temporary development restriction: Only approved emails can invoke LLM-related features.
const ALLOWED_LLM_EMAILS = new Set([
  'andrew.green.contact@gmail.com',
  'nakedsageastrology@gmail.com'
]);

// Firestore-based dynamic allowlist: if a document exists at llm_access/{uid}, grant access even if email not in static set.
async function enforceLLMAccess(context: functions.https.CallableContext) {
  if (!context.auth) { throw new functions.https.HttpsError('unauthenticated','Sign in required'); }
  const email = (context.auth.token.email || '').toLowerCase();
  if (ALLOWED_LLM_EMAILS.has(email)) { return; } // static allowlist fast path
  try {
    const docRef = admin.firestore().collection('llm_access').doc(context.auth.uid);
    const snap = await docRef.get();
    if (snap.exists) { return; }
  } catch { /* ignore; fall through to deny */ }
  throw new functions.https.HttpsError('permission-denied','LLM features restricted during development');
}

async function enforceLLMAccessHttp(token: string): Promise<admin.auth.DecodedIdToken> {
  let decoded: admin.auth.DecodedIdToken;
  try { decoded = await admin.auth().verifyIdToken(token); } catch { throw new functions.https.HttpsError('unauthenticated','Invalid token'); }
  const email = (decoded.email || '').toLowerCase();
  if (ALLOWED_LLM_EMAILS.has(email)) { return decoded; }
  try {
    const docRef = admin.firestore().collection('llm_access').doc(decoded.uid);
    const snap = await docRef.get();
    if (snap.exists) { return decoded; }
  } catch { /* swallow and deny */ }
  throw new functions.https.HttpsError('permission-denied','LLM features restricted during development');
}

export const TIER_ORDER = ['basic','verified','expert','admin'] as const;
export function tierRank(tier: string | undefined): number {
  const idx = TIER_ORDER.indexOf((tier||'').toLowerCase() as any);
  return idx === -1 ? 0 : idx + 1; // 1-based rank; 0 = unknown
}

async function selectModelForUser(uid: string, override?: string): Promise<string> {
  const db = admin.firestore();
  if (override && ALLOWED_MODELS.has(override)) { return override; }
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    const tier = (userSnap.exists && (userSnap.data() as any).tier) || 'basic';
    return TIER_DEFAULT_MODEL[tier] || 'gemini-3-flash-preview';
  } catch {
    return 'gemini-3-flash-preview';
  }
}

interface GeminiGenResult { text: string; modelName: string; promptHash: string; responseHash: string; parsed: any; raw: string; fallback: boolean; statusCode: number | null; }

async function runGeminiDrafts(modelName: string, prompt: string, skipLLM: boolean, apiKey: string | undefined): Promise<GeminiGenResult> {
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  let text: string = '';
  let usedFallback = false;
  let statusCode: number | null = null; // HTTP status from Gemini (null = no network attempt, 0 = skipped)
  if (skipLLM) {
    text = '{"options":[{"label":"A","text":"Stub option A"},{"label":"B","text":"Stub option B"},{"label":"C","text":"Stub option C"}]}'
    usedFallback = true;
    statusCode = 0;
  } else {
    try {
  if (!apiKey) { throw new Error('Gemini key not configured'); }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const maxOutputTokens = modelName.includes('-pro') ? 1024 : 512;
      const body = {
        contents: [ { role: 'user', parts: [{ text: prompt }] } ],
        generationConfig: { temperature: 0.7, maxOutputTokens, responseMimeType: 'application/json' }
      };
      const rResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      statusCode = rResp.status;
      if (!rResp.ok) {
        const msg = await rResp.text();
        const status = rResp.status;
        // Provide structured logging while still falling back gracefully except for misconfiguration
        console.warn('Gemini draft fetch failed', { status, snippet: msg.slice(0,180) });
  if (status === 401 || status === 403) { throw new Error(`Gemini auth error ${status}`); }
  if (status === 429) { throw new Error('Gemini rate limited'); }
        // Non-fatal fallback for 404/model issues
        text = '{"options":[{"label":"A","text":"Model unavailable (fallback stub A)"},{"label":"B","text":"Fallback stub B"},{"label":"C","text":"Fallback stub C"}]}'
        usedFallback = true;
      } else {
        const json: any = await rResp.json();
        const parts = json?.candidates?.[0]?.content?.parts;
        text = parts?.map((p: any)=> p.text).join('\n') || '';
      }
    } catch (e:any) {
      if (e && /Gemini key not configured/.test(e.message || '')) {
        // Hard failure: configuration issue surfaces clearly to caller
        throw e;
      }
      if (!text) {
        text = '{"options":[{"label":"A","text":"Temporary service issue (stub)"},{"label":"B","text":"Retry later"},{"label":"C","text":"Reduced mode"}]}'
        usedFallback = true;
      }
    }
  }
  const responseHash = createHash('sha256').update(text).digest('hex');
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/); if (match) { try { parsed = JSON.parse(match[0]); } catch { /* ignore */ } }
  }
  if (!parsed?.options || !Array.isArray(parsed.options)) {
    parsed = { options: [ { label: 'A', text: text.slice(0,180) } ] };
  }
  // Optional invocation logging (only when real model used & not fallback) – minimal metadata only.
  if (!skipLLM && !usedFallback && (process.env.LOG_LLM_INVOCATIONS === '1')) {
    try { await admin.firestore().collection('llm_invocations').add({ kind: 'drafts', model: modelName, promptHash, responseHash, ts: Date.now() }); } catch { /* ignore logging errors */ }
  }
  return { text, modelName, promptHash, responseHash, parsed, raw: text, fallback: usedFallback, statusCode };
}

// Generic Gemini JSON or text generation (no enforced schema) for chat/summarization
async function runGeminiText(modelName: string, prompt: string, skipLLM: boolean, apiKey: string | undefined, expectJson = false) {
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  let text: string = '';
  let usedFallback = false;
  let statusCode: number | null = null; // HTTP status or 0 if skipped
  if (skipLLM) {
    text = expectJson ? '{"problem":"stub","context":"stub","objectives":[],"constraints":[],"openQuestions":[]}' : 'Stub response (LLM skipped). Provide more detail about the concern.';
    usedFallback = true;
    statusCode = 0;
  } else {
    try {
  if (!apiKey) { throw new Error('Gemini key not configured'); }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const maxOutputTokens = modelName.includes('-pro') ? 1024 : 512;
      const body = { contents: [ { role: 'user', parts: [{ text: prompt }] } ], generationConfig: { temperature: expectJson ? 0.3 : 0.7, maxOutputTokens, responseMimeType: expectJson ? 'application/json' : 'text/plain' } };
      const rResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      statusCode = rResp.status;
      if (!rResp.ok) {
        const msg = await rResp.text();
        const status = rResp.status;
        console.warn('Gemini text fetch failed', { status, snippet: msg.slice(0,180) });
  if (status === 401 || status === 403) { throw new Error(`Gemini auth error ${status}`); }
  if (status === 429) { throw new Error('Gemini rate limited'); }
        // Soft fallback for other statuses (404, 500)
        text = expectJson ? '{"problem":"unavailable","context":"","objectives":[],"constraints":[],"openQuestions":[]}' : 'Assistant temporarily unavailable. Please retry shortly.';
        usedFallback = true;
      } else {
        const json: any = await rResp.json();
        const parts = json?.candidates?.[0]?.content?.parts;
        text = parts?.map((p: any)=> p.text).join('\n') || '';
      }
    } catch (e:any) {
      if (e && /Gemini key not configured/.test(e.message || '')) {
        throw e; // propagate configuration issue
      }
      if (!text) {
        text = expectJson ? '{"problem":"fallback","context":"","objectives":[],"constraints":[],"openQuestions":[]}' : 'Fallback response (LLM unreachable)';
        usedFallback = true;
      }
    }
  }
  const responseHash = createHash('sha256').update(text).digest('hex');
  let parsed: any = null;
  if (expectJson) {
    try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    if (!parsed || typeof parsed.problem !== 'string') {
      parsed = { problem: 'Unparseable', context: '', objectives: [], constraints: [], openQuestions: [] };
    }
  }
  if (!skipLLM && !usedFallback && (process.env.LOG_LLM_INVOCATIONS === '1')) {
    try { await admin.firestore().collection('llm_invocations').add({ kind: expectJson ? 'json' : 'text', model: modelName, promptHash, responseHash, ts: Date.now(), statusCode }); } catch {}
  }
  return { text, promptHash, responseHash, parsed, fallback: usedFallback, statusCode };
}

// Simple health check
export const health = r.https.onRequest((req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// LLM configuration & status diagnostics (no secrets leaked). Callable + HTTP twin for parity.
export const llmConfigStatus = r.https.onCall(async (_data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in required');
  const { geminiApiKey, skipLLM } = getGeminiSettings();
  let source: 'env'|'functions.config'|'missing' = 'missing';
  if (process.env.GEMINI_API_KEY) source = 'env';
  else {
    try { const cfg: any = functions.config(); if (cfg?.gemini?.key) source = 'functions.config'; } catch { /* ignore */ }
  }
  return {
    hasApiKey: !!geminiApiKey,
    skipLLM,
    source,
    allowedEmailsCount: Array.from(ALLOWED_LLM_EMAILS).length,
    timestamp: Date.now(),
    version: 1
  };
});

export const llmConfigStatusHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','GET, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    try { await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const { geminiApiKey, skipLLM } = getGeminiSettings();
    let source: 'env'|'functions.config'|'missing' = 'missing';
    if (process.env.GEMINI_API_KEY) source = 'env'; else { try { const cfg: any = functions.config(); if (cfg?.gemini?.key) source = 'functions.config'; } catch {} }
    res.json({ hasApiKey: !!geminiApiKey, skipLLM, source, allowedEmailsCount: Array.from(ALLOWED_LLM_EMAILS).length, timestamp: Date.now(), version: 1 });
  } catch (e:any) { res.status(500).json({ error: e.message || 'Internal error' }); }
});

// Lightweight self-test: performs a minimal real (or skipped) Gemini invocation to verify connectivity & auth.
// Returns: { ok, model, promptHash, responseHash, fallback, statusCode, skipLLM }
export const llmSelfTest = r.https.onCall(async (_data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in required');
  // LLM access gate (reuse same restrictions)
  await enforceLLMAccess(context);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, 'gemini-3-flash-preview');
  const prompt = 'Return a short JSON object {"ping":"pong"}';
  const { text, promptHash, responseHash, fallback, statusCode } = await runGeminiText(modelName, prompt, skipLLM, apiKey, true);
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { ok: true, model: modelName, promptHash, responseHash, received: parsed, rawLength: text.length, fallback, statusCode, skipLLM };
});

export const llmSelfTestHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','GET, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) { const code = e?.code === 'permission-denied' ? 403 : 401; res.status(code).json({ error: 'Not permitted' }); return; }
    const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, 'gemini-3-flash-preview');
    const prompt = 'Return a short JSON object {"ping":"pong"}';
    const { text, promptHash, responseHash, fallback, statusCode } = await runGeminiText(modelName, prompt, skipLLM, apiKey, true);
    let parsed: any = null; try { parsed = JSON.parse(text); } catch {}
    res.json({ ok: true, model: modelName, promptHash, responseHash, received: parsed, rawLength: text.length, fallback, statusCode, skipLLM });
  } catch (e:any) { res.status(500).json({ error: e.message || 'Internal error' }); }
});

// Read-only prompt library listing (transparency)
export const exportPromptLibrary = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  return { prompts: listPromptLibrary(), exportedAt: Date.now() };
});

// Helper (pure) to build canonical vote JSON for receipt hashing – exported for tests
export function buildVoteCanonical(ballotId: string, voterUid: string, votePayload: any, tsMillis: number) {
  return JSON.stringify({ ballotId, voter: voterUid, vote: votePayload, ts: tsMillis });
}

// (Removed placeholder onCreate concern trigger — drafts are generated explicitly via callable `generateDrafts`).

// HTTP function to generate 3 draft options via Gemini Flash model
export const generateDrafts = r.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }
  await enforceLLMAccess(context);
  const { concernId, variant } = data as { concernId?: string; variant?: string };
  if (!concernId) {
    throw new functions.https.HttpsError('invalid-argument', 'concernId required');
  }
  const db = admin.firestore();
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  if (!concernSnap.exists) throw new functions.https.HttpsError('not-found', 'Concern not found');
  const concern = concernSnap.data() as any;

  // Basic rate limiting (max 10 per user per hour)
  await applyDraftRateLimit(db, context.auth.uid);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, variant);

  const { prompt, templateVersion, templateHash } = buildDraftOptionsPrompt(concern.title, concern.description);
  const { promptHash, responseHash, parsed, text, fallback } = await runGeminiDrafts(modelName, prompt, skipLLM, apiKey);

  // If drafts already exist for this promptHash on this concern, skip (cache hit)
  const existing = await db.collection('drafts')
    .where('concernId','==', concernId)
    .where('modelMeta.promptHash','==', promptHash)
    .limit(1).get();
  if (!existing.empty) {
    return { created: 0, cached: true };
  }
  const batch = db.batch();
  parsed.options.slice(0,3).forEach((opt: any, idx: number) => {
    const ref = db.collection('drafts').doc();
    batch.set(ref, {
      draftId: ref.id,
      concernId,
      version: 1,
      text: `# Option ${opt.label || String.fromCharCode(65+idx)}\n\n${opt.text}`,
      authors: [{ uid: context.auth!.uid, role: 'author' }],
      modelMeta: { model: modelName, promptHash, responseHash, fallback: !!fallback }, // fallback appended once, immutable thereafter
      status: 'drafting',
      citations: [],
      provenance: {
        promptHash,
        responseHash,
        modelVersion: modelName,
        rawResponseSize: text.length,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        templateVersion,
        templateHash,
        fallback: !!fallback
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
  await logEvent({ event: 'generateDrafts', uid: context.auth.uid, refId: concernId, data: { created: Math.min(3, parsed.options.length) } });
  return { created: Math.min(3, parsed.options.length), cached: false, model: modelName, fallback };
});

// CORS-enabled HTTP fallback (in case callable CORS edge cases occur in some environments)
// Accepts POST { concernId } with Authorization: Bearer <ID_TOKEN>
export const generateDraftsHttp = r.https.onRequest(async (req, res) => {
  // Basic CORS handling
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    let decoded: admin.auth.DecodedIdToken;
  try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) {
      const code = e?.code === 'permission-denied' ? 403 : 401;
      res.status(code).json({ error: 'Not permitted' });
      return;
    }
    const bodyObj = typeof req.body === 'object' ? req.body : (typeof req.body === 'string' ? (()=>{ try { return JSON.parse(req.body); } catch { return {}; } })() : {});
    const concernId = bodyObj.concernId;
    const variant = bodyObj.variant as string | undefined;
    if (!concernId) {
      res.status(400).json({ error: 'concernId required' });
      return;
    }
    const db = admin.firestore();
    const concernSnap = await db.collection('concerns').doc(concernId).get();
    if (!concernSnap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
    const concern = concernSnap.data() as any;
    await applyDraftRateLimit(db, decoded.uid);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, variant);
    const { prompt, templateVersion, templateHash } = buildDraftOptionsPrompt(concern.title, concern.description);
  const { promptHash, responseHash, parsed, text, fallback } = await runGeminiDrafts(modelName, prompt, skipLLM, apiKey);
    const existing = await db.collection('drafts')
      .where('concernId','==', concernId)
      .where('modelMeta.promptHash','==', promptHash)
      .limit(1).get();
    if (!existing.empty) { res.json({ created: 0, cached: true, model: modelName }); return; }
    const batch = db.batch();
    parsed.options.slice(0,3).forEach((opt: any, idx: number) => {
      const ref = db.collection('drafts').doc();
      batch.set(ref, {
        draftId: ref.id,
        concernId,
        version: 1,
        text: `# Option ${opt.label || String.fromCharCode(65+idx)}\n\n${opt.text}`,
        authors: [{ uid: decoded.uid, role: 'author' }],
        modelMeta: { model: modelName, promptHash, responseHash, fallback: !!fallback },
        status: 'drafting',
        citations: [],
        provenance: { promptHash, responseHash, modelVersion: modelName, rawResponseSize: text.length, createdAt: admin.firestore.FieldValue.serverTimestamp(), templateVersion, templateHash, fallback: !!fallback },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    await logEvent({ event: 'generateDrafts', uid: decoded.uid, refId: concernId, data: { created: Math.min(3, parsed.options.length), model: modelName } });
  res.json({ created: Math.min(3, parsed.options.length), cached: false, via: 'http', model: modelName, fallback });
  } catch (e: any) {
    console.error('generateDraftsHttp error', e);
    res.status(500).json({ error: e.message || 'Internal error', code: 'drafts_http_failed' });
  }
});

// Create ballot (simple|approval|rcv)
export const createBallot = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const { concernId, type, options, durationMinutes = 60, minTier = 'basic', regions } = data as { concernId: string; type: string; options: any[]; durationMinutes?: number; minTier?: string; regions?: string[] };
  if (!concernId || !Array.isArray(options) || options.length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'concernId and >=2 options required');
  }
  if (!['simple','approval','rcv'].includes(type)) throw new functions.https.HttpsError('invalid-argument','Unsupported type');
  if (!TIER_ORDER.includes(minTier as any)) throw new functions.https.HttpsError('invalid-argument','Invalid minTier');
  const db = admin.firestore();
  // Server-side tier gating (parity with Firestore rules). Require at least 'verified' and user tier >= requested minTier.
  try {
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    const userTier = userDoc.exists ? (userDoc.data() as any).tier || 'basic' : 'basic';
    const rank = tierRank(userTier);
    if (rank < tierRank('verified')) {
      throw new functions.https.HttpsError('permission-denied','Tier too low to create ballot');
    }
    if (rank < tierRank(minTier)) {
      throw new functions.https.HttpsError('permission-denied','Tier below specified minTier');
    }
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    throw new functions.https.HttpsError('failed-precondition','Tier check failed');
  }
  await applyBallotCreateRateLimit(db, context.auth.uid);
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  if (!concernSnap.exists) throw new functions.https.HttpsError('not-found','Concern not found');
  // Prevent overlapping open ballot for same concern
  const overlap = await db.collection('ballots').where('concernId','==', concernId).where('status','==','open').limit(1).get();
  if (!overlap.empty) throw new functions.https.HttpsError('failed-precondition','An open ballot already exists for this concern');
  // Review gating: every referenced draft (option id assumed to be draftId when prefixed by 'draft_' or explicit) must have at least one qualifying review
  // We treat option.id as draftId when a draft with that id exists.
  const draftIds: string[] = [];
  for (const o of options) {
    if (o && o.id) draftIds.push(o.id);
  }
  if (draftIds.length) {
    const draftSnaps = await Promise.all(draftIds.map(id=> db.collection('drafts').doc(id).get()));
    for (let i=0;i<draftSnaps.length;i++) {
      const ds = draftSnaps[i];
      if (ds.exists) {
        const ddata = ds.data() as any;
        const reviews: any[] = ddata.reviews || [];
        const hasQual = reviews.some(r=> ['legal','fact','expert'].includes(r.kind) && ['expert','admin'].includes(r.role));
        if (!hasQual) throw new functions.https.HttpsError('failed-precondition',`Draft ${ds.id} missing expert/legal/fact review`);
      }
    }
  }
  const now = admin.firestore.Timestamp.now();
  const ballotRef = db.collection('ballots').doc();
  const endAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + durationMinutes * 60_000);
  let optionSnapshots: any[] = [];
  try {
    const snaps = await Promise.all(options.map((o:any)=> o?.id ? db.collection('drafts').doc(o.id).get() : Promise.resolve(null as any)));
    snaps.forEach((s, idx) => {
      if (s && s.exists) {
        const d = s.data() as any;
        optionSnapshots.push({
          optionId: options[idx].id || null,
          draftId: d.draftId || s.id,
          promptHash: d.modelMeta?.promptHash || d.provenance?.promptHash || null,
          responseHash: d.modelMeta?.responseHash || d.provenance?.responseHash || null,
          model: d.modelMeta?.model || d.provenance?.modelVersion || null,
          templateVersion: d.provenance?.templateVersion || null,
          templateHash: d.provenance?.templateHash || null
        });
      }
    });
  } catch (e) { console.warn('optionSnapshots build failed', e); optionSnapshots = []; }
  // Normalize and de-duplicate region filters (strings like country:US, state:US-OR, city:US-OR-Winston)
  let allowedRegions: string[] = [];
  if (Array.isArray(regions)) {
    allowedRegions = Array.from(new Set(regions.filter(rg=> typeof rg === 'string' && rg.length < 80)));
    if (allowedRegions.length > 25) allowedRegions = allowedRegions.slice(0,25); // guard
  }
  await ballotRef.set({
    ballotId: ballotRef.id,
    concernId,
    type,
    options: options.map((o: any, i: number) => ({ id: o.id || `opt_${i}`, label: o.label || o.text || `Option ${i+1}` })),
    optionSnapshots,
    startAt: now,
    endAt,
    status: 'open',
    createdBy: context.auth.uid,
    minTier,
    minTierRank: tierRank(minTier),
    allowedRegions: allowedRegions.length ? allowedRegions : null,
    createdAt: now,
    updatedAt: now
  });
  return { ballotId: ballotRef.id };
});

// HTTP fallback for createBallot with CORS
export const createBallotHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object' ? req.body : (typeof req.body === 'string' ? (()=>{ try { return JSON.parse(req.body); } catch { return {}; } })() : {});
  const { concernId, type, options, durationMinutes = 60, minTier = 'basic', regions } = body;
    if (!concernId || !Array.isArray(options) || options.length < 2) { res.status(400).json({ error: 'concernId and >=2 options required' }); return; }
    if (!['simple','approval','rcv'].includes(type)) { res.status(400).json({ error: 'Unsupported type' }); return; }
    if (!TIER_ORDER.includes((minTier||'').toLowerCase())) { res.status(400).json({ error: 'Invalid minTier' }); return; }
    const db = admin.firestore();
    // Server-side tier gating (HTTP): must be verified+ and >= minTier requested
    try {
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      const userTier = userDoc.exists ? (userDoc.data() as any).tier || 'basic' : 'basic';
      const rank = tierRank(userTier);
      if (rank < tierRank('verified')) { res.status(403).json({ error: 'Tier too low to create ballot' }); return; }
      if (rank < tierRank(minTier)) { res.status(403).json({ error: 'Tier below specified minTier' }); return; }
    } catch (e:any) {
      res.status(500).json({ error: 'Tier check failed' }); return;
    }
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  await applyBallotCreateRateLimit(db, decoded.uid);
    if (!concernSnap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
  const overlap = await db.collection('ballots').where('concernId','==', concernId).where('status','==','open').limit(1).get();
  if (!overlap.empty) { res.status(412).json({ error: 'An open ballot already exists' }); return; }
    // Review gating similar to callable version
    const draftIds: string[] = [];
    for (const o of options) { if (o && o.id) draftIds.push(o.id); }
    if (draftIds.length) {
      const draftSnaps = await Promise.all(draftIds.map((id:string)=> db.collection('drafts').doc(id).get()));
      for (const ds of draftSnaps) {
        if (ds.exists) {
          const ddata = ds.data() as any; const reviews: any[] = ddata.reviews || [];
          const hasQual = reviews.some(r=> ['legal','fact','expert'].includes(r.kind) && ['expert','admin'].includes(r.role));
          if (!hasQual) { res.status(412).json({ error: `Draft ${ds.id} missing expert/legal/fact review` }); return; }
        }
      }
    }
    const now = admin.firestore.Timestamp.now();
    const ballotRef = db.collection('ballots').doc();
    const endAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + durationMinutes * 60_000);
    let optionSnapshots: any[] = [];
    try {
      const snaps = await Promise.all(options.map((o:any)=> o?.id ? db.collection('drafts').doc(o.id).get() : Promise.resolve(null as any)));
      snaps.forEach((s, idx) => {
        if (s && s.exists) {
          const d = s.data() as any;
          optionSnapshots.push({
            optionId: options[idx].id || null,
            draftId: d.draftId || s.id,
            promptHash: d.modelMeta?.promptHash || d.provenance?.promptHash || null,
            responseHash: d.modelMeta?.responseHash || d.provenance?.responseHash || null,
            model: d.modelMeta?.model || d.provenance?.modelVersion || null,
            templateVersion: d.provenance?.templateVersion || null,
            templateHash: d.provenance?.templateHash || null
          });
        }
      });
    } catch (e) { console.warn('optionSnapshots build failed (http)', e); optionSnapshots = []; }
    let allowedRegions: string[] = [];
    if (Array.isArray(regions)) {
      allowedRegions = Array.from(new Set(regions.filter((rg:string)=> typeof rg === 'string' && rg.length < 80)));
      if (allowedRegions.length > 25) allowedRegions = allowedRegions.slice(0,25);
    }
    await ballotRef.set({
      ballotId: ballotRef.id,
      concernId,
      type,
      options: options.map((o: any, i: number) => ({ id: o.id || `opt_${i}`, label: o.label || o.text || `Option ${i+1}` })),
      optionSnapshots,
      startAt: now,
      endAt,
      status: 'open',
      createdBy: decoded.uid,
      minTier,
      minTierRank: tierRank(minTier),
      allowedRegions: allowedRegions.length ? allowedRegions : null,
      createdAt: now,
      updatedAt: now
    });
    res.json({ ballotId: ballotRef.id });
  } catch (e: any) {
    console.error('createBallotHttp error', e);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

interface TallyResult { counts: Record<string, number>; total: number; rounds?: any[]; winner?: string|null; exhausted?: number; }

// Cast vote (last-write-wins). For RCV expects ranking[], for approval expects approvals[], for simple expects choice
export const castVote = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in required');
  const { ballotId, ranking, approvals, choice } = data;
  if (!ballotId) throw new functions.https.HttpsError('invalid-argument','ballotId required');
  const db = admin.firestore();
  const ballotSnap = await db.collection('ballots').doc(ballotId).get();
  if (!ballotSnap.exists) throw new functions.https.HttpsError('not-found','Ballot not found');
  const ballot = ballotSnap.data() as any;
  // Eligibility: user tier + region must satisfy ballot constraints
  try {
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    const udata = userDoc.exists ? userDoc.data() as any : {};
    const userTier = udata.tier || 'basic';
    const userRank = tierRank(userTier);
    if (ballot.minTierRank && userRank < ballot.minTierRank) {
      throw new functions.https.HttpsError('permission-denied','Tier too low to vote on this ballot');
    }
    if (Array.isArray(ballot.allowedRegions) && ballot.allowedRegions.length) {
      const region = udata.region || {}; // expecting { country, state, city }
      const tokens: string[] = [];
      if (region.country) tokens.push(`country:${region.country}`);
      if (region.state) tokens.push(`state:${region.country}-${region.state}`);
      if (region.city) tokens.push(`city:${region.country}-${region.state}-${region.city}`);
      const match = tokens.some(t => ballot.allowedRegions.includes(t));
      if (!match) throw new functions.https.HttpsError('permission-denied','Region not eligible for this ballot');
    }
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e; // rethrow
    throw new functions.https.HttpsError('failed-precondition','Eligibility check failed');
  }
  const now = admin.firestore.Timestamp.now();
  if (ballot.status !== 'open' || ballot.endAt.toMillis() < now.toMillis()) {
    throw new functions.https.HttpsError('failed-precondition','Ballot closed');
  }
  await applyVoteRateLimit(db, context.auth.uid, ballotId);
  const secret = getReceiptSecret();
  if (!secret) throw new functions.https.HttpsError('failed-precondition','Receipt secret not configured');
  const voterHash = createHash('sha256').update(context.auth.uid + ballotId).digest('hex');
  let votePayload: any = {};
  if (ballot.type === 'rcv') {
    if (!Array.isArray(ranking) || ranking.length === 0) throw new functions.https.HttpsError('invalid-argument','ranking required');
    votePayload.ranking = ranking.filter((c: string)=> ballot.options.some((o: any)=>o.id===c));
  } else if (ballot.type === 'approval') {
    if (!Array.isArray(approvals) || approvals.length === 0) throw new functions.https.HttpsError('invalid-argument','approvals required');
    votePayload.approvals = approvals.filter((c: string)=> ballot.options.some((o: any)=>o.id===c));
  } else {
    if (!choice) throw new functions.https.HttpsError('invalid-argument','choice required');
    if (!ballot.options.some((o: any)=>o.id===choice)) throw new functions.https.HttpsError('invalid-argument','invalid choice');
    votePayload.choice = choice;
  }
  const canonical = buildVoteCanonical(ballotId, context.auth.uid, votePayload, now.toMillis());
  const receiptHash = createHmac('sha256', secret).update(canonical).digest('hex').slice(0,32);
  // Optional KMS signature over canonical vote (excluding secret)
  let kmsSignature: any = null;
  try {
    const sig = await kmsSign(Buffer.from(canonical));
    if (sig) kmsSignature = sig;
  } catch { /* ignore */ }
  const voteRef = db.collection('votes').doc(voterHash);
  await voteRef.set({
    voteId: voterHash,
    ballotId,
    voterUid: context.auth.uid,
    voterHash,
    ...votePayload,
    receiptHash,
    kmsSignature: kmsSignature || null,
    createdAt: now,
    updatedAt: now
  }, { merge: true });
  await logEvent({ event: 'castVote', uid: context.auth.uid, refId: ballotId, data: { type: ballot.type } });
  return { receipt: `CSR-RECEIPT-${receiptHash.slice(0,8)}`, receiptHash };
});

// HTTP fallback for castVote
export const castVoteHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object' ? req.body : (typeof req.body === 'string' ? (()=>{ try { return JSON.parse(req.body); } catch { return {}; } })() : {});
    const { ballotId, ranking, approvals, choice } = body;
    if (!ballotId) { res.status(400).json({ error: 'ballotId required' }); return; }
    const db = admin.firestore();
  const ballotSnap = await db.collection('ballots').doc(ballotId).get();
    if (!ballotSnap.exists) { res.status(404).json({ error: 'Ballot not found' }); return; }
    const ballot = ballotSnap.data() as any;
    // Eligibility: user tier + region must meet constraints
    try {
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      const udata = userDoc.exists ? userDoc.data() as any : {};
      const userTier = udata.tier || 'basic';
      const userRank = tierRank(userTier);
      if (ballot.minTierRank && userRank < ballot.minTierRank) {
        res.status(403).json({ error: 'Tier too low to vote on this ballot' }); return;
      }
      if (Array.isArray(ballot.allowedRegions) && ballot.allowedRegions.length) {
        const region = udata.region || {};
        const tokens: string[] = [];
        if (region.country) tokens.push(`country:${region.country}`);
        if (region.state) tokens.push(`state:${region.country}-${region.state}`);
        if (region.city) tokens.push(`city:${region.country}-${region.state}-${region.city}`);
        const match = tokens.some(t => ballot.allowedRegions.includes(t));
        if (!match) { res.status(403).json({ error: 'Region not eligible for this ballot' }); return; }
      }
    } catch {
      res.status(500).json({ error: 'Eligibility check failed' }); return;
    }
    const now = admin.firestore.Timestamp.now();
    if (ballot.status !== 'open' || ballot.endAt.toMillis() < now.toMillis()) { res.status(400).json({ error: 'Ballot closed' }); return; }
  await applyVoteRateLimit(db, decoded.uid, ballotId);
  const secret = getReceiptSecret();
    if (!secret) { res.status(500).json({ error: 'Receipt secret not configured' }); return; }
    const voterHash = createHash('sha256').update(decoded.uid + ballotId).digest('hex');
    let votePayload: any = {};
    if (ballot.type === 'rcv') {
      if (!Array.isArray(ranking) || ranking.length === 0) { res.status(400).json({ error: 'ranking required' }); return; }
      votePayload.ranking = ranking.filter((c: string)=> ballot.options.some((o: any)=>o.id===c));
    } else if (ballot.type === 'approval') {
      if (!Array.isArray(approvals) || approvals.length === 0) { res.status(400).json({ error: 'approvals required' }); return; }
      votePayload.approvals = approvals.filter((c: string)=> ballot.options.some((o: any)=>o.id===c));
    } else {
      if (!choice) { res.status(400).json({ error: 'choice required' }); return; }
      if (!ballot.options.some((o: any)=>o.id===choice)) { res.status(400).json({ error: 'invalid choice' }); return; }
      votePayload.choice = choice;
    }
  const canonical = buildVoteCanonical(ballotId, decoded.uid, votePayload, now.toMillis());
    const receiptHash = createHmac('sha256', secret).update(canonical).digest('hex').slice(0,32);
    let kmsSignature: any = null; try { const sig = await kmsSign(Buffer.from(canonical)); if (sig) kmsSignature = sig; } catch {}
    const voteRef = db.collection('votes').doc(voterHash);
    await voteRef.set({ voteId: voterHash, ballotId, voterUid: decoded.uid, voterHash, ...votePayload, receiptHash, kmsSignature: kmsSignature || null, createdAt: now, updatedAt: now }, { merge: true });
    await logEvent({ event: 'castVote', uid: decoded.uid, refId: ballotId, data: { type: ballot.type } });
    res.json({ receipt: `CSR-RECEIPT-${receiptHash.slice(0,8)}`, receiptHash });
  } catch (e: any) {
    console.error('castVoteHttp error', e);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

// Tally ballot (idempotent). For RCV naive implementation (not optimized). Restrict to creator for now.
export const tallyBallot = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in required');
  const { ballotId } = data;
  if (!ballotId) throw new functions.https.HttpsError('invalid-argument','ballotId required');
  const db = admin.firestore();
  const ballotRef = db.collection('ballots').doc(ballotId);
  const ballotSnap = await ballotRef.get();
  if (!ballotSnap.exists) throw new functions.https.HttpsError('not-found','Ballot not found');
  const ballot = ballotSnap.data() as any;
  if (ballot.createdBy !== context.auth.uid) throw new functions.https.HttpsError('permission-denied','Not allowed');
  if (ballot.status === 'tallied') return { alreadyTallied: true, results: ballot.results };
  const votesSnap = await db.collection('votes').where('ballotId','==', ballotId).get();
  const votes = votesSnap.docs.map(d=>d.data());
  
  // Resolve delegations
  const concernSnap = await db.collection('concerns').doc(ballot.concernId).get();
  const concern = concernSnap.exists ? concernSnap.data() as any : {};
  const topics = concern.topics || [];
  
  const usersSnap = await db.collection('users').get();
  const delegationMap: Record<string, string> = {};
  usersSnap.docs.forEach(doc => {
    const udata = doc.data();
    if (udata.delegations) {
      for (const topic of topics) {
        const delegate = udata.delegations[`topic:${topic}`];
        if (delegate) {
          delegationMap[doc.id] = delegate;
          break;
        }
      }
    }
  });

  const directVoteMap = new Map<string, any>();
  votes.forEach(v => {
    if (v.voterUid) directVoteMap.set(v.voterUid, v);
  });

  const weights = new Map<string, number>();
  directVoteMap.forEach((_, uid) => weights.set(uid, 1));

  usersSnap.docs.forEach(doc => {
    const userId = doc.id;
    if (directVoteMap.has(userId)) return;
    let current = userId;
    const path = new Set<string>();
    path.add(current);
    let depth = 0;
    while (delegationMap[current] && depth < 5) {
      const next = delegationMap[current];
      if (path.has(next)) break;
      path.add(next);
      current = next;
      depth++;
      if (directVoteMap.has(current)) {
        const w = weights.get(current) || 0;
        weights.set(current, w + 1);
        break;
      }
    }
  });

  const totalWeight = Array.from(weights.values()).reduce((a,b)=>a+b,0);
  let results: TallyResult = { counts: {}, total: totalWeight };
  if (ballot.type === 'simple') {
    ballot.options.forEach((o: any)=> results.counts[o.id]=0);
    votes.forEach(v=> {
      if (v.choice && v.voterUid) {
        const w = weights.get(v.voterUid) || 1;
        results.counts[v.choice] = (results.counts[v.choice]||0) + w;
      }
    });
    const winner = Object.entries(results.counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    results.winner = winner;
  } else if (ballot.type === 'approval') {
    ballot.options.forEach((o: any)=> results.counts[o.id]=0);
    votes.forEach(v=> {
      if (v.voterUid) {
        const w = weights.get(v.voterUid) || 1;
        (v.approvals||[]).forEach((id: string)=> results.counts[id]=(results.counts[id]||0)+w);
      }
    });
    const winner = Object.entries(results.counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    results.winner = winner;
  } else { // rcv via shared lib
    const rcvBallots = votes.map((v: any) => ({
      ranking: Array.isArray(v.ranking) ? v.ranking.filter((c:string)=> ballot.options.some((o:any)=>o.id===c)) : [],
      weight: v.voterUid ? (weights.get(v.voterUid) || 1) : 1
    }));
    const tieBreaker = ballot.options.map((o: any) => o.id);
    const outcome = tallyRCV(rcvBallots, tieBreaker);
    results.rounds = outcome.rounds;
    results.winner = outcome.winner;
    if (typeof outcome.exhausted === 'number') results.exhausted = outcome.exhausted;
  }
  // Deterministic tally hash (exclude signatures). Includes type + rounds when present.
  const tallyHash = createHash('sha256').update(JSON.stringify({ ballotId, type: ballot.type, results })).digest('hex');
  // Sign tally results (canonical) if KMS available
  const tallyCanonical = JSON.stringify({ ballotId, results });
  let tallySignature: any = null;
  try {
    const sig = await kmsSign(Buffer.from(tallyCanonical));
    if (sig) tallySignature = sig;
  } catch { /* ignore */ }
  // Begin ledger write in transaction to ensure single entry per ballot
  const dbNow = admin.firestore.Timestamp.now();
  await admin.firestore().runTransaction(async tx => {
    const freshBallot = await tx.get(ballotRef);
    const bData = freshBallot.data() as any;
    if (bData.ledgerId) {
      // Another concurrent tally already wrote ledger, just update core fields (idempotent)
      tx.set(ballotRef, { status: 'tallied', results, tallySignature, tallyHash, updatedAt: dbNow }, { merge: true });
      return;
    }
    // Allocate next ledger sequence via singleton meta doc to avoid race conditions.
    const ledgerCol = admin.firestore().collection('transparency_ledger');
    const metaRef = admin.firestore().collection('ledger_meta').doc('sequence');
    const metaSnap = await tx.get(metaRef);
    let seq: number; let prevHash: string | null;
    if (metaSnap.exists) {
      const md = metaSnap.data() as any;
      seq = (md.lastSeq || 0) + 1;
      prevHash = md.lastEntryHash || null;
    } else {
      // Migration fallback: derive from existing ledger if any
      const lastSnap = await tx.get(ledgerCol.orderBy('seq','desc').limit(1));
      if (!lastSnap.empty) {
        const last = lastSnap.docs[0].data() as any;
        seq = (last.seq || 0) + 1;
        prevHash = last.entryHash;
      } else {
        seq = 1; prevHash = null;
      }
    }
    const dataPayload = { kind: 'tally', ballotId, results, ts: Date.now() };
    const { canonical, entryHash } = buildCanonical(seq, prevHash, dataPayload);
    let ledgerSignature: any = null;
    try { const sig = await kmsSign(Buffer.from(canonical)); if (sig) ledgerSignature = sig; } catch { /* ignore */ }
    const ledgerRef = ledgerCol.doc();
    tx.set(ledgerRef, { ledgerId: ledgerRef.id, seq, prevHash, entryHash, data: dataPayload, canonical, signature: ledgerSignature, createdAt: dbNow });
    // Update meta doc with new sequence & hash (idempotent for this transaction)
    tx.set(metaRef, { lastSeq: seq, lastEntryHash: entryHash, updatedAt: dbNow }, { merge: true });
    tx.set(ballotRef, { status: 'tallied', results, tallySignature, tallyHash, ledgerId: ledgerRef.id, updatedAt: dbNow }, { merge: true });
  });
  await logEvent({ event: 'tallyBallot', uid: context.auth.uid, refId: ballotId, data: { winner: results.winner } });
  try {
    // Create audit report document (lightweight) linking to ledger entry & summarizing outcomes
    const db = admin.firestore();
    const reportRef = db.collection('audit_reports').doc(ballotId);
    await reportRef.set({
      ballotId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      results,
      winner: results.winner || null,
      totalVotes: results.total,
      rounds: results.rounds || null,
      ledgerId: (await db.collection('ballots').doc(ballotId).get()).data()?.ledgerId || null,
      tallySignature: (await db.collection('ballots').doc(ballotId).get()).data()?.tallySignature || null,
      tallyHash: (await db.collection('ballots').doc(ballotId).get()).data()?.tallyHash || null
    }, { merge: true });
    // Public mirror (sanitized)
    const pubRef = db.collection('audit_public').doc(ballotId);
    await pubRef.set({
      ballotId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      winner: results.winner || null,
      totalVotes: results.total,
      exhausted: results.exhausted || null,
      rounds: (results.rounds || []).map((r:any)=> ({ counts: r.counts, eliminated: r.eliminated || null })),
      tallyHash: (await db.collection('ballots').doc(ballotId).get()).data()?.tallyHash || null,
      ledgerId: (await db.collection('ballots').doc(ballotId).get()).data()?.ledgerId || null
    }, { merge: true });
  } catch (e) {
    console.warn('audit report creation failed', e);
  }
  return { results };
});

// --- Receipt Verification ---
// Callable verifyReceipt: client submits { receiptHash, ballotId? }
// Returns: { valid: boolean, ballotId?, shortCode?, type?, submittedAt?, voteShape? } without exposing voter identity.
export const verifyReceipt = r.https.onCall(async (data, context) => {
  const { receiptHash, ballotId } = data as { receiptHash?: string; ballotId?: string };
  if (!receiptHash || typeof receiptHash !== 'string' || receiptHash.length < 8) {
    return { valid: false, error: 'invalid-argument' };
  }
  const db = admin.firestore();
  let query = db.collection('votes').where('receiptHash','==', receiptHash.slice(0,32));
  if (ballotId) query = query.where('ballotId','==', ballotId);
  const snap = await query.limit(1).get();
  if (snap.empty) return { valid: false };
  const vote = snap.docs[0].data() as any;
  const result: any = {
    valid: true,
    ballotId: vote.ballotId,
    shortCode: `CSR-RECEIPT-${receiptHash.slice(0,8)}`,
    type: vote.ranking ? 'rcv' : (vote.approvals ? 'approval' : 'simple'),
    submittedAt: vote.updatedAt || vote.createdAt || null
  };
  // Provide minimal shape for client-side self-verification (without voter identity)
  if (vote.ranking) result.voteShape = { rankingLength: Array.isArray(vote.ranking) ? vote.ranking.length : 0 };
  else if (vote.approvals) result.voteShape = { approvalsCount: Array.isArray(vote.approvals) ? vote.approvals.length : 0 };
  else if (vote.choice) result.voteShape = { choice: true };
  return result;
});

export const verifyReceiptHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const body = typeof req.body === 'object' ? req.body : (typeof req.body === 'string' ? (()=>{ try { return JSON.parse(req.body); } catch { return {}; } })() : {});
    const { receiptHash, ballotId } = body;
  if (!receiptHash || typeof receiptHash !== 'string' || receiptHash.length < 8) { res.status(200).json({ valid: false, error: 'invalid-argument' }); return; }
    const db = admin.firestore();
    let query = db.collection('votes').where('receiptHash','==', receiptHash.slice(0,32));
    if (ballotId) query = query.where('ballotId','==', ballotId);
    const snap = await query.limit(1).get();
    if (snap.empty) { res.json({ valid: false }); return; }
    const vote = snap.docs[0].data() as any;
    const result: any = {
      valid: true,
      ballotId: vote.ballotId,
      shortCode: `CSR-RECEIPT-${receiptHash.slice(0,8)}`,
      type: vote.ranking ? 'rcv' : (vote.approvals ? 'approval' : 'simple'),
      submittedAt: vote.updatedAt || vote.createdAt || null
    };
    if (vote.ranking) result.voteShape = { rankingLength: Array.isArray(vote.ranking) ? vote.ranking.length : 0 };
    else if (vote.approvals) result.voteShape = { approvalsCount: Array.isArray(vote.approvals) ? vote.approvals.length : 0 };
    else if (vote.choice) result.voteShape = { choice: true };
    res.json(result);
  } catch (e: any) {
    console.error('verifyReceiptHttp error', e);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

// User bootstrap trigger - create users doc with default tier if not existing
export const onAuthCreate = functions.auth.user().onCreate(async (user) => {
  const db = admin.firestore();
  const ref = db.collection('users').doc(user.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      uid: user.uid,
      email: user.email || null,
      tier: 'basic',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await logEvent({ event: 'userCreated', uid: user.uid });
  }
});

// Callable to set user tier (requires admin presence in /admins/{callerUid})
export const setUserTier = r.https.onCall( async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { targetUid, tier } = data;
  if (!targetUid || !tier) throw new functions.https.HttpsError('invalid-argument','targetUid & tier required');
  const db = admin.firestore();
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists) throw new functions.https.HttpsError('permission-denied','Not admin');
  const allowed = ['basic','verified','expert','admin'];
  if (!allowed.includes(tier)) throw new functions.https.HttpsError('invalid-argument','Invalid tier');
  await db.collection('users').doc(targetUid).set({ tier, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  try {
    // Preserve existing claims, only override tier
    const userRecord = await admin.auth().getUser(targetUid);
    const existingClaims = userRecord.customClaims || {};
    await admin.auth().setCustomUserClaims(targetUid, { ...existingClaims, tier });
  } catch (e) {
    console.warn('Failed to set custom claims for tier', e);
  }
  await logEvent({ event: 'setUserTier', uid: context.auth.uid, refId: targetUid, data: { tier } });
  return { ok: true, tier, claimsUpdated: true };
});

// --- Moderation: report content (concern/draft/ballot) ---
// Firestore doc shape (collection: moderation_reports):
// { reportId, targetRef, reason, note?, reporter: uid, status: 'open'|'reviewed', createdAt, updatedAt }
// Reasons limited to enum to simplify triage dashboard.
const MODERATION_REASONS = new Set(['hate','harassment','spam','illicit','self-harm','other']);

export const reportContent = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { targetRef, reason, note } = data as { targetRef?: string; reason?: string; note?: string };
  if (!targetRef || !reason) throw new functions.https.HttpsError('invalid-argument','targetRef & reason required');
  if (!MODERATION_REASONS.has(reason)) throw new functions.https.HttpsError('invalid-argument','Invalid reason');
  // Very lightweight existence check (only for well-known prefixes)
  const db = admin.firestore();
  const [col] = targetRef.split('/');
  if (!['concerns','drafts','ballots'].includes(col)) throw new functions.https.HttpsError('invalid-argument','Unsupported target collection');
  try {
    const snap = await db.doc(targetRef).get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found','Target not found');
    await applyModerationRateLimit(db, context.auth.uid, targetRef);
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    throw new functions.https.HttpsError('internal','Lookup failed');
  }
  const ref = db.collection('moderation_reports').doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    reportId: ref.id,
    targetRef,
    reason,
    note: (note||'').slice(0,500),
    reporter: context.auth.uid,
    status: 'open',
    createdAt: now,
    updatedAt: now
  });
  await logEvent({ event: 'reportContent', uid: context.auth.uid, refId: ref.id, data: { targetRef, reason } });
  return { ok: true, reportId: ref.id };
});

export const reportContentHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object' ? req.body : (typeof req.body === 'string' ? (()=>{ try { return JSON.parse(req.body); } catch { return {}; } })() : {});
    const { targetRef, reason, note } = body;
    if (!targetRef || !reason) { res.status(400).json({ error: 'targetRef & reason required' }); return; }
    if (!MODERATION_REASONS.has(reason)) { res.status(400).json({ error: 'Invalid reason' }); return; }
    const [col] = targetRef.split('/');
    if (!['concerns','drafts','ballots'].includes(col)) { res.status(400).json({ error: 'Unsupported target collection' }); return; }
    const db = admin.firestore();
    const snap = await db.doc(targetRef).get();
    if (!snap.exists) { res.status(404).json({ error: 'Target not found' }); return; }
  try { await applyModerationRateLimit(db, decoded.uid, targetRef); } catch (e:any) { res.status(429).json({ error: e.message||'Rate limited' }); return; }
    const ref = db.collection('moderation_reports').doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({ reportId: ref.id, targetRef, reason, note: (note||'').slice(0,500), reporter: decoded.uid, status: 'open', createdAt: now, updatedAt: now });
    await logEvent({ event: 'reportContent', uid: decoded.uid, refId: ref.id, data: { targetRef, reason } });
    res.json({ ok: true, reportId: ref.id });
  } catch (e: any) {
    console.error('reportContentHttp error', e);
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

// List open moderation reports (admin only)
export const listOpenReports = r.https.onCall(async (_, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const db = admin.firestore();
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists) throw new functions.https.HttpsError('permission-denied','Not admin');
  const snap = await db.collection('moderation_reports').where('status','==','open').orderBy('createdAt','asc').limit(50).get();
  return { reports: snap.docs.map(d=> ({ reportId: d.id, ...(d.data()), note: undefined })) }; // hide note maybe? keep note? choose to hide to reduce bias
});

export const listOpenReportsHttp = r.https.onRequest( async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const db = admin.firestore();
    const a = await db.collection('admins').doc(decoded.uid).get();
    if (!a.exists) { res.status(403).json({ error: 'Not admin' }); return; }
    const snap = await db.collection('moderation_reports').where('status','==','open').orderBy('createdAt','asc').limit(50).get();
    res.json({ reports: snap.docs.map(d=> ({ reportId: d.id, ...(d.data()), note: undefined })) });
  } catch (e:any) { res.status(500).json({ error: e.message||'Internal error' }); }
});

// Resolve moderation report (admin)
export const resolveReport = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { reportId, action, publicRationale } = data as { reportId?: string; action?: string; publicRationale?: string };
  if (!reportId || !action) throw new functions.https.HttpsError('invalid-argument','reportId & action required');
  if (!['none','flag','remove','escalate'].includes(action)) throw new functions.https.HttpsError('invalid-argument','Invalid action');
  const db = admin.firestore();
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists) throw new functions.https.HttpsError('permission-denied','Not admin');
  const ref = db.collection('moderation_reports').doc(reportId);
  const snap = await ref.get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found','Report not found');
  if ((snap.data() as any).status !== 'open') return { alreadyResolved: true };
  const pubRationale = (publicRationale||'').slice(0,400);
  const resolvedAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({ status: 'reviewed', action, publicRationale: pubRationale, resolvedBy: context.auth.uid, resolvedAt }, { merge: true });
  try {
    const sanitized = { reportId, targetRef: (snap.data() as any).targetRef, action, publicRationale: pubRationale, resolvedAt: admin.firestore.FieldValue.serverTimestamp() };
    await db.collection('moderation_public').doc(reportId).set(sanitized, { merge: true });
  } catch (e) { console.warn('Failed to publish moderation_public', e); }
  await logEvent({ event: 'resolveReport', uid: context.auth.uid, refId: reportId, data: { action } });
  return { ok: true };
});

export const resolveReportHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const { reportId, action, publicRationale } = typeof req.body === 'object'? req.body : {}; 
    if (!reportId || !action) { res.status(400).json({ error: 'reportId & action required' }); return; }
    if (!['none','flag','remove','escalate'].includes(action)) { res.status(400).json({ error: 'Invalid action' }); return; }
    const db = admin.firestore();
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) { res.status(403).json({ error: 'Not admin' }); return; }
    const ref = db.collection('moderation_reports').doc(reportId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Not found' }); return; }
    if ((snap.data() as any).status !== 'open') { res.json({ alreadyResolved: true }); return; }
    const pubRationale = (publicRationale||'').slice(0,400);
    await ref.set({ status: 'reviewed', action, publicRationale: pubRationale, resolvedBy: decoded.uid, resolvedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    try {
      const sanitized = { reportId, targetRef: (snap.data() as any).targetRef, action, publicRationale: pubRationale, resolvedAt: admin.firestore.FieldValue.serverTimestamp() };
      await db.collection('moderation_public').doc(reportId).set(sanitized, { merge: true });
    } catch (e) { console.warn('Failed to publish moderation_public (http)', e); }
    await logEvent({ event: 'resolveReport', uid: decoded.uid, refId: reportId, data: { action } });
    res.json({ ok: true });
  } catch (e:any) { res.status(500).json({ error: e.message||'Internal error' }); }
});

// Current user role (admin flag)
export const currentUserRole = r.https.onCall(async (_, context) => {
  if (!context.auth) return { admin: false };
  const snap = await admin.firestore().collection('admins').doc(context.auth.uid).get();
  return { admin: snap.exists };
});

// ---------- Draft Citations & Reviews (Provenance Extensions) ----------
// We keep provenance immutable; instead we allow appending to top-level `citations` & `reviews` arrays.
// Helper to merge citations (dedupe by docId+url) and enforce size/field limits.
export interface DraftCitation { docId?: string; url?: string; excerpt?: string; }
export function mergeCitations(existing: DraftCitation[], incoming: DraftCitation[], max = 25): DraftCitation[] {
  const norm = (c: DraftCitation) => ({
    docId: (c.docId||'').slice(0,64) || undefined,
    url: (c.url||'').slice(0,256) || undefined,
    excerpt: (c.excerpt||'').slice(0,280) || undefined
  });
  const map = new Map<string, DraftCitation>();
  existing.forEach(c => { const nc = norm(c); if (nc.docId || nc.url) map.set(`${nc.docId||''}|${nc.url||''}`, nc); });
  incoming.forEach(c => { const nc = norm(c); if (nc.docId || nc.url) map.set(`${nc.docId||''}|${nc.url||''}`, nc); });
  return Array.from(map.values()).slice(0, max);
}

export interface DraftReview { uid: string; role: string; kind: 'legal'|'fact'|'expert'; note?: string; signedAt: number; signature?: any; }
export function canAddReview(existing: DraftReview[], uid: string, kind: string): boolean {
  // prevent duplicate review of same kind by same user
  return !existing.some(r => r.uid === uid && r.kind === kind);
}

// Reputation: simple heuristic – each unique accepted review adds +1.
export function computeReputationIncrementForReview(kind: string): number {
  return ['legal','fact','expert'].includes(kind) ? 1 : 0;
}

export const appendCitations = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { draftId, citations } = data as { draftId?: string; citations?: DraftCitation[] };
  if (!draftId || !Array.isArray(citations) || citations.length === 0) throw new functions.https.HttpsError('invalid-argument','draftId & citations[] required');
  const db = admin.firestore();
  const ref = db.collection('drafts').doc(draftId);
  const snap = await ref.get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found','Draft not found');
  const dData = snap.data() as any;
  // Only authors or admins can append citations
  const isAuthor = (dData.authors||[]).some((a: any)=> a.uid === context.auth!.uid);
  const isAdmin = (await db.collection('admins').doc(context.auth.uid).get()).exists;
  if (!isAuthor && !isAdmin) throw new functions.https.HttpsError('permission-denied','Not allowed');
  await applyCitationRateLimit(db, context.auth.uid, draftId);
  const merged = mergeCitations(dData.citations || [], citations);
  await ref.set({ citations: merged, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await logEvent({ event: 'appendCitations', uid: context.auth.uid, refId: draftId, data: { added: citations.length } });
  return { ok: true, citations: merged.length };
});

export const appendCitationsHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object'? req.body : {};
    const { draftId, citations } = body;
    if (!draftId || !Array.isArray(citations) || citations.length === 0) { res.status(400).json({ error: 'draftId & citations[] required' }); return; }
    const db = admin.firestore();
    const ref = db.collection('drafts').doc(draftId);
    const snap = await ref.get(); if (!snap.exists) { res.status(404).json({ error: 'Draft not found' }); return; }
    const dData = snap.data() as any;
    const isAuthor = (dData.authors||[]).some((a: any)=> a.uid === decoded.uid);
    const isAdmin = (await db.collection('admins').doc(decoded.uid).get()).exists;
    if (!isAuthor && !isAdmin) { res.status(403).json({ error: 'Not allowed' }); return; }
  try { await applyCitationRateLimit(db, decoded.uid, draftId); } catch (e:any) { res.status(429).json({ error: e.message||'Rate limited' }); return; }
  const merged = mergeCitations(dData.citations || [], citations);
    await ref.set({ citations: merged, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await logEvent({ event: 'appendCitations', uid: decoded.uid, refId: draftId, data: { added: citations.length } });
    res.json({ ok: true, citations: merged.length });
  } catch (e:any) { res.status(500).json({ error: e.message||'Internal error' }); }
});

export const submitDraftReview = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { draftId, kind, note } = data as { draftId?: string; kind?: 'legal'|'fact'|'expert'; note?: string };
  if (!draftId || !kind) throw new functions.https.HttpsError('invalid-argument','draftId & kind required');
  if (!['legal','fact','expert'].includes(kind)) throw new functions.https.HttpsError('invalid-argument','Invalid kind');
  const db = admin.firestore();
  const ref = db.collection('drafts').doc(draftId);
  const snap = await ref.get(); if (!snap.exists) throw new functions.https.HttpsError('not-found','Draft not found');
  const userDoc = await db.collection('users').doc(context.auth.uid).get();
  const tier = userDoc.exists ? (userDoc.data() as any).tier : 'basic';
  if (!['expert','admin'].includes(tier)) throw new functions.https.HttpsError('permission-denied','Tier insufficient');
  const dData = snap.data() as any;
  const existing: DraftReview[] = dData.reviews || [];
  if (!canAddReview(existing, context.auth.uid, kind)) return { alreadyReviewed: true };
  await applyReviewRateLimit(db, context.auth.uid, draftId);
  const review: DraftReview = { uid: context.auth.uid, role: tier, kind, note: (note||'').slice(0,500), signedAt: Date.now() };
  // Optionally KMS sign canonical review
  try {
    const canonical = JSON.stringify({ draftId, uid: review.uid, kind: review.kind, signedAt: review.signedAt });
    const sig = await kmsSign(Buffer.from(canonical)); if (sig) review.signature = sig;
  } catch { /* ignore */ }
  await ref.set({ reviews: [...existing, review], updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  try {
    const inc = computeReputationIncrementForReview(kind);
    if (inc > 0) {
      await db.collection('users').doc(context.auth.uid).set({ reputation: admin.firestore.FieldValue.increment(inc), tier, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  } catch (e) { console.warn('reputation increment failed', e); }
  await logEvent({ event: 'submitDraftReview', uid: context.auth.uid, refId: draftId, data: { kind } });
  return { ok: true };
});

export const submitDraftReviewHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object'? req.body : {};
    const { draftId, kind, note } = body;
    if (!draftId || !kind) { res.status(400).json({ error: 'draftId & kind required' }); return; }
    if (!['legal','fact','expert'].includes(kind)) { res.status(400).json({ error: 'Invalid kind' }); return; }
    const db = admin.firestore();
    const ref = db.collection('drafts').doc(draftId);
    const snap = await ref.get(); if (!snap.exists) { res.status(404).json({ error: 'Draft not found' }); return; }
    const userDoc = await db.collection('users').doc(decoded.uid).get(); const tier = userDoc.exists ? (userDoc.data() as any).tier : 'basic';
    if (!['expert','admin'].includes(tier)) { res.status(403).json({ error: 'Tier insufficient' }); return; }
    const dData = snap.data() as any;
    const existing: DraftReview[] = dData.reviews || [];
    if (!canAddReview(existing, decoded.uid, kind)) { res.json({ alreadyReviewed: true }); return; }
  try { await applyReviewRateLimit(db, decoded.uid, draftId); } catch (e:any) { res.status(429).json({ error: e.message||'Rate limited' }); return; }
  const review: DraftReview = { uid: decoded.uid, role: tier, kind, note: (note||'').slice(0,500), signedAt: Date.now() };
    try { const canonical = JSON.stringify({ draftId, uid: review.uid, kind: review.kind, signedAt: review.signedAt }); const sig = await kmsSign(Buffer.from(canonical)); if (sig) review.signature = sig; } catch {}
    await ref.set({ reviews: [...existing, review], updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    try {
      const inc = computeReputationIncrementForReview(kind);
      if (inc>0) await db.collection('users').doc(decoded.uid).set({ reputation: admin.firestore.FieldValue.increment(inc), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) { console.warn('reputation increment failed (http)', e); }
    await logEvent({ event: 'submitDraftReview', uid: decoded.uid, refId: draftId, data: { kind } });
    res.json({ ok: true });
  } catch (e:any) { res.status(500).json({ error: e.message||'Internal error' }); }
});

// Append edit history entry (immutable provenance rule: cannot alter existing entries)
// Draft doc field: editHistory: [{ uid, ts, changeSummary }]
export const appendDraftEditHistory = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { draftId, changeSummary } = data as { draftId?: string; changeSummary?: string };
  if (!draftId || !changeSummary) throw new functions.https.HttpsError('invalid-argument','draftId & changeSummary required');
  if (changeSummary.length > 500) throw new functions.https.HttpsError('invalid-argument','changeSummary too long');
  const db = admin.firestore();
  const ref = db.collection('drafts').doc(draftId);
  const snap = await ref.get(); if (!snap.exists) throw new functions.https.HttpsError('not-found','Draft not found');
  const entry = { uid: context.auth.uid, ts: admin.firestore.FieldValue.serverTimestamp(), changeSummary };
  await ref.update({ editHistory: admin.firestore.FieldValue.arrayUnion(entry), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await logEvent({ event: 'appendEditHistory', uid: context.auth.uid, refId: draftId, data: { len: changeSummary.length } });
  return { ok: true };
});

export const appendDraftEditHistoryHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization'); res.set('Access-Control-Allow-Methods','POST, OPTIONS'); res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization||''; const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null; if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object'? req.body : {}; const { draftId, changeSummary } = body;
    if (!draftId || !changeSummary) { res.status(400).json({ error: 'draftId & changeSummary required' }); return; }
    if (typeof changeSummary !== 'string' || changeSummary.length > 500) { res.status(400).json({ error: 'changeSummary invalid' }); return; }
    const db = admin.firestore(); const ref = db.collection('drafts').doc(draftId); const snap = await ref.get(); if (!snap.exists) { res.status(404).json({ error: 'Draft not found' }); return; }
    const entry = { uid: decoded.uid, ts: admin.firestore.FieldValue.serverTimestamp(), changeSummary };
    await ref.update({ editHistory: admin.firestore.FieldValue.arrayUnion(entry), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logEvent({ event: 'appendEditHistory', uid: decoded.uid, refId: draftId, data: { len: changeSummary.length } });
    res.json({ ok: true });
  } catch (e:any) { console.error('appendDraftEditHistoryHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

// ---------------- Delegations -----------------
// A user can delegate a topic-specific vote influence to another user.
// Stored under users/{uid}.delegations: { "topic:<topic>": delegateUid }
// Validation: topic slug 2-32 chars, a-z0-9_- ; cannot delegate to self.
export function validateDelegationTopic(topic: string): boolean {
  return /^[a-z0-9_-]{2,32}$/.test(topic);
}

async function applyDelegationRateLimit(db: FirebaseFirestore.Firestore, uid: string) {
  const rlRef = db.collection('rate_limits').doc(`deleg_${uid}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 60*60*1000; // 1 hour
    let count = 0; let since = now;
    if (snap.exists) {
      const d = snap.data() as any; count = d.count||0; since = d.since||now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 20) throw new functions.https.HttpsError('resource-exhausted','Too many delegation updates');
    }
    tx.set(rlRef, { count: count+1, since }, { merge: true });
  });
}

export const setDelegation = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { topic, delegateUid } = data as { topic?: string; delegateUid?: string|null };
  if (!topic) throw new functions.https.HttpsError('invalid-argument','topic required');
  if (!validateDelegationTopic(topic)) throw new functions.https.HttpsError('invalid-argument','Invalid topic slug');
  if (delegateUid && delegateUid === context.auth.uid) throw new functions.https.HttpsError('invalid-argument','Cannot delegate to self');
  const db = admin.firestore();
  await applyDelegationRateLimit(db, context.auth.uid);
  // Ensure delegate exists if provided
  if (delegateUid) {
    const ds = await db.collection('users').doc(delegateUid).get();
    if (!ds.exists) throw new functions.https.HttpsError('not-found','Delegate user not found');
  }
  const fieldName = `delegations.topic:${topic}`;
  const update: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp(), tier: (await db.collection('users').doc(context.auth.uid).get()).data()?.tier || 'basic' };
  if (delegateUid) update[fieldName] = delegateUid; else update[fieldName] = admin.firestore.FieldValue.delete();
  // Preserve tier immutability rule: we never touch tier here.
  await db.collection('users').doc(context.auth.uid).set(update, { merge: true });
  await logEvent({ event: 'setDelegation', uid: context.auth.uid, data: { topic, delegateUid: delegateUid || null } });
  return { ok: true };
});

export const setDelegationHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const { topic, delegateUid } = typeof req.body === 'object' ? req.body : {};
    if (!topic) { res.status(400).json({ error: 'topic required' }); return; }
    if (!validateDelegationTopic(topic)) { res.status(400).json({ error: 'Invalid topic slug' }); return; }
    if (delegateUid && delegateUid === decoded.uid) { res.status(400).json({ error: 'Cannot delegate to self' }); return; }
    const db = admin.firestore();
    try { await applyDelegationRateLimit(db, decoded.uid); } catch (e:any) { res.status(429).json({ error: e.message || 'Rate limited' }); return; }
    if (delegateUid) {
      const ds = await db.collection('users').doc(delegateUid).get();
      if (!ds.exists) { res.status(404).json({ error: 'Delegate user not found' }); return; }
    }
    const fieldName = `delegations.topic:${topic}`;
  const update: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp(), tier: (await db.collection('users').doc(decoded.uid).get()).data()?.tier || 'basic' };
    update[fieldName] = delegateUid ? delegateUid : admin.firestore.FieldValue.delete();
    await db.collection('users').doc(decoded.uid).set(update, { merge: true });
    await logEvent({ event: 'setDelegation', uid: decoded.uid, data: { topic, delegateUid: delegateUid || null } });
    res.json({ ok: true });
  } catch (e:any) { console.error('setDelegationHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

// Export ballot audit bundle (read-only, aggregates existing data). Callable only since no mutation.
export const exportBallotReport = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { ballotId } = data as { ballotId?: string };
  if (!ballotId) throw new functions.https.HttpsError('invalid-argument','ballotId required');
  const db = admin.firestore();
  const ballotSnap = await db.collection('ballots').doc(ballotId).get();
  if (!ballotSnap.exists) throw new functions.https.HttpsError('not-found','Ballot not found');
  const ballot = ballotSnap.data() as any;
  if (ballot.status !== 'tallied') throw new functions.https.HttpsError('failed-precondition','Ballot not tallied');
  // Find ledger entry if any
  let ledgerEntry: any = null;
  if (ballot.ledgerId) {
    const ledSnap = await db.collection('transparency_ledger').doc(ballot.ledgerId).get();
    if (ledSnap.exists) ledgerEntry = ledSnap.data();
  }
  const reportSnap = await db.collection('audit_reports').doc(ballotId).get();
  const report = reportSnap.exists ? reportSnap.data() : null;
  // Gather anonymized votes & receipt hashes (exclude voterHash for privacy). Only include minimal shape by ballot type.
  const votesSnap = await db.collection('votes').where('ballotId','==', ballotId).get();
  const anonymizedVotes = votesSnap.docs.map(d => {
    const v = d.data() as any;
    if (ballot.type === 'rcv') return { ranking: v.ranking || [], receiptHash: v.receiptHash };
    if (ballot.type === 'approval') return { approvals: v.approvals || [], receiptHash: v.receiptHash };
    return { choice: v.choice || null, receiptHash: v.receiptHash };
  });
  const receiptHashes = Array.from(new Set(anonymizedVotes.map(v=> v.receiptHash).filter(Boolean)));
  // Optional provenance summary: fetch drafts referenced by options when IDs map to real drafts
  let draftProvenance: any[] = [];
  try {
    const draftIds = (ballot.options||[]).map((o:any)=> o.id).filter((id:string)=> !!id);
    if (draftIds.length) {
      const snaps = await Promise.all(draftIds.map((id:string)=> db.collection('drafts').doc(id).get()));
      draftProvenance = snaps.filter(s=> s.exists).map(s => {
        const d = s.data() as any;
        return {
          draftId: d.draftId || s.id,
            promptHash: d.modelMeta?.promptHash || d.provenance?.promptHash || null,
            responseHash: d.modelMeta?.responseHash || d.provenance?.responseHash || null,
            model: d.modelMeta?.model || d.provenance?.modelVersion || null,
            templateVersion: d.provenance?.templateVersion || null,
            templateHash: d.provenance?.templateHash || null
        };
      });
    }
  } catch (e) {
    console.warn('draft provenance collection failed', e);
  }
  const algorithm = {
    type: ballot.type,
    version: '1.0',
    tieBreak: ballot.type === 'rcv' ? 'lexicographically-last-of-lowest' : null,
    hashInputs: 'sha256(JSON.stringify({ ballotId, type, results }))'
  };
  const exportObj = {
    ballot: {
      ballotId: ballot.ballotId,
      concernId: ballot.concernId,
      type: ballot.type,
      options: ballot.options,
      optionSnapshots: ballot.optionSnapshots || null,
      results: ballot.results,
      winner: ballot.results?.winner || null,
      tallySignature: ballot.tallySignature || null,
      ledgerId: ballot.ledgerId || null,
      minTier: ballot.minTier || 'basic',
      tallyHash: ballot.tallyHash || null,
      exhausted: ballot.results?.exhausted || null
    },
    ledgerEntry: ledgerEntry ? {
      seq: ledgerEntry.seq,
      entryHash: ledgerEntry.entryHash,
      prevHash: ledgerEntry.prevHash,
      canonicalHash: ledgerEntry.entryHash,
      hasSignature: !!ledgerEntry.signature
    } : null,
    auditReport: report ? { totalVotes: report.totalVotes, rounds: report.rounds, winner: report.winner } : null,
    votes: anonymizedVotes,
    receiptHashes,
    draftProvenance,
    algorithm,
    exportedAt: Date.now()
  };
  let signature: any = null;
  try {
    const sig = await kmsSign(Buffer.from(JSON.stringify(exportObj)));
    if (sig) signature = sig;
  } catch { /* ignore */ }
  return { export: exportObj, signature };
});

// List recent ledger entries (read-only). Returns up to `limit` latest entries with seq, hashes, and kind metadata.
export const listLedgerEntries = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { limit: lim } = data || {};
  const limitNum = typeof lim === 'number' && lim > 0 && lim <= 200 ? lim : 50;
  const db = admin.firestore();
  const snap = await db.collection('transparency_ledger').orderBy('seq','desc').limit(limitNum).get();
  const entries = snap.docs.map(d => {
    const x = d.data() as any;
    return { ledgerId: x.ledgerId || d.id, seq: x.seq, prevHash: x.prevHash || null, entryHash: x.entryHash, kind: x.data?.kind || null, ballotId: x.data?.ballotId || null, ts: x.data?.ts || null, hasSignature: !!x.signature };
  });
  return { entries };
});

// Chat message rate limit: max 60 messages per user per hour
async function applyChatRateLimit(db: FirebaseFirestore.Firestore, uid: string) {
  const rlRef = db.collection('rate_limits').doc(`chat_${uid}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 60*60*1000;
    let count = 0; let since = now;
    if (snap.exists) {
      const d = snap.data() as any; count = d.count||0; since = d.since||now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 60) throw new functions.https.HttpsError('resource-exhausted','Chat rate limit');
    }
    tx.set(rlRef, { count: count+1, since }, { merge: true });
  });
}

// Per-concern chat limiter (20 messages/hour per concern per user)
async function applyChatConcernRateLimit(db: FirebaseFirestore.Firestore, uid: string, concernId: string) {
  const rlRef = db.collection('rate_limits').doc(`chatc_${concernId}_${uid}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(rlRef);
    const now = Date.now();
    const windowStart = now - 60*60*1000;
    let count = 0; let since = now;
    if (snap.exists) {
      const d = snap.data() as any; count = d.count||0; since = d.since||now;
      if (since < windowStart) { count = 0; since = now; }
      if (count >= 20) throw new functions.https.HttpsError('resource-exhausted','Chat concern limit');
    }
    tx.set(rlRef, { count: count+1, since }, { merge: true });
  });
}

// -------------- Concern Chat & Summarization (LLM Assistant) --------------
// Firestore doc shape (collection: concern_chats/{concernId}/messages/{msgId}) not stored yet; we keep ephemeral chat client-side for now to reduce write volume.
// Instead, we optionally persist summarized objects later when generating drafts (future iteration can add chat persistence & provenance chain).

export const chatRepresentative = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  await enforceLLMAccess(context);
  const { messages } = data as { messages?: { role: 'user'|'assistant'; text: string }[] };
  if (!Array.isArray(messages)) throw new functions.https.HttpsError('invalid-argument','messages required');
  const db = admin.firestore();
  await applyChatRateLimit(db, context.auth.uid);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, 'gemini-3-flash-preview');
  
  if (skipLLM) {
    return { reply: "Stub representative reply.", extractedConcern: null };
  }
  
  const { reply, extractedConcern } = await runGeminiRepresentative(modelName, messages, apiKey!);
  
  let concernId: string | null = null;
  if (extractedConcern && extractedConcern.title && extractedConcern.description) {
    const ref = await db.collection('concerns').add({
      title: extractedConcern.title,
      description: extractedConcern.description,
      status: 'idea',
      createdBy: context.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    concernId = ref.id;
  }
  
  return { reply, extractedConcern, concernId };
});

export const chatRepresentativeHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization'); res.set('Access-Control-Allow-Methods','POST, OPTIONS'); res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization||''; const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null; if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) { const code = e?.code === 'permission-denied' ? 403 : 401; res.status(code).json({ error: 'Not permitted', code: 'llm_restricted' }); return; }
    const body = typeof req.body === 'object'? req.body : {}; const { messages } = body;
    if (!Array.isArray(messages)) { res.status(400).json({ error: 'messages required' }); return; }
    const db = admin.firestore();
    try { await applyChatRateLimit(db, decoded.uid); } catch (e:any) { res.status(429).json({ error: e.message || 'Rate limited' }); return; }
    const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, 'gemini-3-flash-preview');
    
    if (skipLLM) {
      res.json({ reply: "Stub representative reply.", extractedConcern: null });
      return;
    }
    
    const { reply, extractedConcern } = await runGeminiRepresentative(modelName, messages, apiKey!);
    
    let concernId: string | null = null;
    if (extractedConcern && extractedConcern.title && extractedConcern.description) {
      const ref = await db.collection('concerns').add({
        title: extractedConcern.title,
        description: extractedConcern.description,
        status: 'idea',
        createdBy: decoded.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      concernId = ref.id;
    }
    
    res.json({ reply, extractedConcern, concernId });
  } catch (e:any) { console.error('chatRepresentativeHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

export const chatConcern = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  // Development LLM feature gate
  await enforceLLMAccess(context);
  const { concernId, title, messages } = data as { concernId?: string; title?: string; messages?: { role: 'user'|'assistant'; text: string }[] };
  if (!concernId || !title || !Array.isArray(messages)) throw new functions.https.HttpsError('invalid-argument','concernId,title,messages required');
  const db = admin.firestore();
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  if (!concernSnap.exists) throw new functions.https.HttpsError('not-found','Concern not found');
  // Dedicated chat rate limit
  await applyChatRateLimit(db, context.auth.uid);
  await applyChatConcernRateLimit(db, context.auth.uid, concernId);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, 'gemini-3-flash-preview'); // chat always uses cheapest adequate
  const { prompt, templateVersion, templateHash } = buildConcernChatPrompt(title, messages);
  const { text, promptHash, responseHash, fallback } = await runGeminiText(modelName, prompt, skipLLM, apiKey, false);
  await logEvent({ event: 'chatConcern', uid: context.auth.uid, refId: concernId, data: { promptHash, responseHash } });
  return { reply: text, model: modelName, promptHash, responseHash, templateVersion, templateHash, fallback };
});

export const chatConcernHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization'); res.set('Access-Control-Allow-Methods','POST, OPTIONS'); res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization||''; const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null; if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
  let decoded: admin.auth.DecodedIdToken; try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) { const code = e?.code === 'permission-denied' ? 403 : 401; res.status(code).json({ error: 'Not permitted', code: 'llm_restricted' }); return; }
    const body = typeof req.body === 'object'? req.body : {}; const { concernId, title, messages } = body;
    if (!concernId || !title || !Array.isArray(messages)) { res.status(400).json({ error: 'concernId,title,messages required' }); return; }
    const db = admin.firestore(); const concernSnap = await db.collection('concerns').doc(concernId).get(); if (!concernSnap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
  try { await applyChatRateLimit(db, decoded.uid); await applyChatConcernRateLimit(db, decoded.uid, concernId); } catch (e:any) { res.status(429).json({ error: e.message || 'Rate limited' }); return; }
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, 'gemini-3-flash-preview');
    const { prompt, templateVersion, templateHash } = buildConcernChatPrompt(title, messages);
  const { text, promptHash, responseHash, fallback } = await runGeminiText(modelName, prompt, skipLLM, apiKey, false);
    await logEvent({ event: 'chatConcern', uid: decoded.uid, refId: concernId, data: { promptHash, responseHash } });
  res.json({ reply: text, model: modelName, promptHash, responseHash, templateVersion, templateHash, fallback });
  } catch (e:any) { console.error('chatConcernHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

export const summarizeConcern = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  // Development LLM feature gate
  await enforceLLMAccess(context);
  const { concernId, title, messages } = data as { concernId?: string; title?: string; messages?: { role: 'user'|'assistant'; text: string }[] };
  if (!concernId || !title || !Array.isArray(messages)) throw new functions.https.HttpsError('invalid-argument','concernId,title,messages required');
  const db = admin.firestore(); const concernSnap = await db.collection('concerns').doc(concernId).get(); if (!concernSnap.exists) throw new functions.https.HttpsError('not-found','Concern not found');
  await applyChatRateLimit(db, context.auth.uid);
  await applyChatConcernRateLimit(db, context.auth.uid, concernId);
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, 'gemini-3-flash-preview');
  const { prompt, templateVersion, templateHash } = buildConcernSummaryPrompt(title, messages);
  const { text, promptHash, responseHash, parsed, fallback } = await runGeminiText(modelName, prompt, skipLLM, apiKey, true);
  await logEvent({ event: 'summarizeConcern', uid: context.auth.uid, refId: concernId, data: { promptHash, responseHash } });
  return { summary: parsed, model: modelName, promptHash, responseHash, templateVersion, templateHash, fallback };
});

export const summarizeConcernHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization'); res.set('Access-Control-Allow-Methods','POST, OPTIONS'); res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization||''; const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null; if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
  let decoded: admin.auth.DecodedIdToken; try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) { const code = e?.code === 'permission-denied' ? 403 : 401; res.status(code).json({ error: 'Not permitted', code: 'llm_restricted' }); return; }
    const body = typeof req.body === 'object'? req.body : {}; const { concernId, title, messages } = body;
    if (!concernId || !title || !Array.isArray(messages)) { res.status(400).json({ error: 'concernId,title,messages required' }); return; }
    const db = admin.firestore(); const concernSnap = await db.collection('concerns').doc(concernId).get(); if (!concernSnap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
  try { await applyChatRateLimit(db, decoded.uid); await applyChatConcernRateLimit(db, decoded.uid, concernId); } catch (e:any) { res.status(429).json({ error: e.message || 'Rate limited' }); return; }
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, 'gemini-3-flash-preview');
    const { prompt, templateVersion, templateHash } = buildConcernSummaryPrompt(title, messages);
  const { text, promptHash, responseHash, parsed, fallback } = await runGeminiText(modelName, prompt, skipLLM, apiKey, true);
    await logEvent({ event: 'summarizeConcern', uid: decoded.uid, refId: concernId, data: { promptHash, responseHash } });
  res.json({ summary: parsed, model: modelName, promptHash, responseHash, templateVersion, templateHash, fallback });
  } catch (e:any) { console.error('summarizeConcernHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

// Incremental chat with persistence & action suggestion parsing.
// Firestore subcollection path: concern_chats/{concernId}/messages/{autoId}
// Message doc: { role: 'user'|'assistant', text, createdAt, promptHash?, responseHash?, actions?[] }
export const chatSend = r.https.onCall( async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  // Development LLM feature gate
  await enforceLLMAccess(context);
  const { concernId, message } = data as { concernId?: string; message?: string };
  if (!concernId || !message) throw new functions.https.HttpsError('invalid-argument','concernId & message required');
  const db = admin.firestore();
  const concernSnap = await db.collection('concerns').doc(concernId).get();
  if (!concernSnap.exists) throw new functions.https.HttpsError('not-found','Concern not found');
  await applyChatRateLimit(db, context.auth.uid);
  await applyChatConcernRateLimit(db, context.auth.uid, concernId);
  // Load last 60 messages; compress earlier ones into a rolling summary
  const msgsSnap = await db.collection('concern_chats').doc(concernId).collection('messages').orderBy('createdAt','asc').limitToLast(60).get();
  const fullHistory = msgsSnap.docs.map(d => d.data() as any).map(m => ({ role: m.role, text: m.text }));
  fullHistory.push({ role: 'user', text: message });
  const { toSummarize, tail } = partitionForSummary(fullHistory, 14); // keep a slightly larger recent tail
  let summaryBlock = '';
  if (toSummarize.length >= 6) { // only summarize if enough earlier context
    const { summary } = buildRollingSummary(toSummarize);
    summaryBlock = `\n--- EARLIER CONTEXT SUMMARY START ---\n${summary}\n--- EARLIER CONTEXT SUMMARY END ---\n`;
  }
  const history = tail; // use tail as direct messages input to prompt builder
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  const modelName = await selectModelForUser(context.auth.uid, 'gemini-3-flash-preview');
  // Build prompt with lightweight agent instruction layer for action suggestions
  const baseTitle = (concernSnap.data() as any).title || 'Concern';
  const agentTip = '\nIf the user seems ready, after your answer add a line starting with ACTION_JSON: followed by JSON {"actions":[{"type":"generate_drafts","label":"Generate Draft Options"}]} or empty list. Only suggest generate_drafts when drafts do not yet exist.';
  const { prompt, templateVersion, templateHash } = buildConcernChatPrompt(baseTitle, history as { role: 'user' | 'assistant'; text: string }[]);
  const combinedPrompt = summaryBlock + prompt + agentTip;
  const { text, promptHash, responseHash, fallback } = await runGeminiText(modelName, combinedPrompt, skipLLM, apiKey, false);
  // Structured action suggestion parsing
  const ALLOWED_ACTIONS = new Set(['generate_drafts']);
  const parsedAct = parseActionSuggestions(text, ALLOWED_ACTIONS);
  let reply = parsedAct.reply;
  let actions: any[] = parsedAct.actions;
  // Persist user + assistant messages
  const MAX_CHARS = 1800;
  if (reply.length > MAX_CHARS) reply = reply.slice(0, MAX_CHARS) + '…';
  let disallowedTerms = ['forbiddenterm'];
  try {
    const configSnap = await db.collection('config').doc('moderation').get();
    if (configSnap.exists) {
      const data = configSnap.data() as any;
      if (Array.isArray(data.disallowedTerms)) {
        disallowedTerms = data.disallowedTerms;
      }
    }
  } catch (e) {
    console.warn('Failed to load dynamic moderation config', e);
  }
  const moderation = moderateAssistantReply(reply, disallowedTerms);
  reply = moderation.sanitized;
  // Already filtered by parser
  const chatCol = db.collection('concern_chats').doc(concernId).collection('messages');
  const now = admin.firestore.FieldValue.serverTimestamp();
  const userMsgRef = chatCol.doc();
  const assistantMsgRef = chatCol.doc();
  await db.runTransaction(async tx => {
    tx.set(userMsgRef, { messageId: userMsgRef.id, role: 'user', text: message.slice(0,4000), createdAt: now, uid: context.auth!.uid });
  tx.set(assistantMsgRef, { messageId: assistantMsgRef.id, role: 'assistant', text: reply.slice(0,4000), createdAt: now, promptHash, responseHash, actions, model: modelName, templateVersion, templateHash, moderation: { flags: moderation.flags, blocked: moderation.blocked } });
  });
  const tokenEst = estimateTokens(combinedPrompt) + estimateTokens(reply);
  await logEvent({ event: 'chatSend', uid: context.auth.uid, refId: concernId, data: { promptHash, responseHash, actions: actions.map(a=>a.type), tokenEst, actionBlock: parsedAct.rawMatched && actions.length === 0 ? 'filtered' : undefined } });
  return { reply, actions, promptHash, responseHash, model: modelName, moderation: { flags: moderation.flags, blocked: moderation.blocked }, tokenEst, fallback };
});

export const chatSendHttp = r.https.onRequest(async (req,res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin); res.set('Vary','Origin'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization'); res.set('Access-Control-Allow-Methods','POST, OPTIONS'); res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization||''; const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null; if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
  let decoded: admin.auth.DecodedIdToken; try { decoded = await enforceLLMAccessHttp(token); } catch (e:any) { const code = e?.code === 'permission-denied' ? 403 : 401; res.status(code).json({ error: 'Not permitted', code: 'llm_restricted' }); return; }
    const body = typeof req.body === 'object'? req.body : {}; const { concernId, message } = body;
    if (!concernId || !message) { res.status(400).json({ error: 'concernId & message required' }); return; }
    const db = admin.firestore();
    const concernSnap = await db.collection('concerns').doc(concernId).get(); if (!concernSnap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
  try { await applyChatRateLimit(db, decoded.uid); await applyChatConcernRateLimit(db, decoded.uid, concernId); } catch (e:any) { res.status(429).json({ error: e.message || 'Rate limited' }); return; }
    const msgsSnap = await db.collection('concern_chats').doc(concernId).collection('messages').orderBy('createdAt','asc').limitToLast(60).get();
    const fullHistory = msgsSnap.docs.map(d=>d.data() as any).map(m=>({ role: m.role, text: m.text }));
    fullHistory.push({ role: 'user', text: message });
    const { toSummarize, tail } = partitionForSummary(fullHistory, 14);
    let summaryBlock = '';
    if (toSummarize.length >= 6) {
      const { summary } = buildRollingSummary(toSummarize);
      summaryBlock = `\n--- EARLIER CONTEXT SUMMARY START ---\n${summary}\n--- EARLIER CONTEXT SUMMARY END ---\n`;
    }
    const history = tail;
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
    const modelName = await selectModelForUser(decoded.uid, 'gemini-3-flash-preview');
    const baseTitle = (concernSnap.data() as any).title || 'Concern';
    const agentTip = '\nIf the user seems ready, after your answer add a line starting with ACTION_JSON: followed by JSON {"actions":[{"type":"generate_drafts","label":"Generate Draft Options"}]} or empty list. Only suggest generate_drafts when drafts do not yet exist.';
  const { prompt, templateVersion, templateHash } = buildConcernChatPrompt(baseTitle, history as { role: 'user' | 'assistant'; text: string }[]);
  const combinedPrompt = summaryBlock + prompt + agentTip;
  const { text, promptHash, responseHash, fallback } = await runGeminiText(modelName, combinedPrompt, skipLLM, apiKey, false);
  const ALLOWED_ACTIONS_HTTP = new Set(['generate_drafts']);
  const parsedAct = parseActionSuggestions(text, ALLOWED_ACTIONS_HTTP);
  let reply = parsedAct.reply; let actions: any[] = parsedAct.actions;
  const MAX_CHARS = 1800; if (reply.length > MAX_CHARS) reply = reply.slice(0, MAX_CHARS) + '…';
  let disallowedTerms = ['forbiddenterm'];
  try {
    const configSnap = await db.collection('config').doc('moderation').get();
    if (configSnap.exists) {
      const data = configSnap.data() as any;
      if (Array.isArray(data.disallowedTerms)) {
        disallowedTerms = data.disallowedTerms;
      }
    }
  } catch (e) {
    console.warn('Failed to load dynamic moderation config', e);
  }
  const moderation = moderateAssistantReply(reply, disallowedTerms); reply = moderation.sanitized;
  // Already filtered
  const chatCol = db.collection('concern_chats').doc(concernId).collection('messages');
    const now = admin.firestore.FieldValue.serverTimestamp();
    const userMsgRef = chatCol.doc(); const assistantMsgRef = chatCol.doc();
    await db.runTransaction(async tx => {
      tx.set(userMsgRef, { messageId: userMsgRef.id, role: 'user', text: message.slice(0,4000), createdAt: now, uid: decoded.uid });
  tx.set(assistantMsgRef, { messageId: assistantMsgRef.id, role: 'assistant', text: reply.slice(0,4000), createdAt: now, promptHash, responseHash, actions, model: modelName, templateVersion, templateHash, moderation: { flags: moderation.flags, blocked: moderation.blocked } });
    });
  const tokenEst = estimateTokens(combinedPrompt) + estimateTokens(reply);
  await logEvent({ event: 'chatSend', uid: decoded.uid, refId: concernId, data: { promptHash, responseHash, actions: actions.map(a=>a.type), tokenEst, actionBlock: parsedAct.rawMatched && actions.length === 0 ? 'filtered' : undefined } });
  res.json({ reply, actions, promptHash, responseHash, model: modelName, moderation: { flags: moderation.flags, blocked: moderation.blocked }, tokenEst, fallback });
  } catch (e:any) { console.error('chatSendHttp error', e); res.status(500).json({ error: e.message || 'Internal error' }); }
});

export const dailyConcernAggregation = r.pubsub.schedule('every 24 hours').onRun(async (context) => {
  await runDailyAggregation();
});

export const dailyAgenticDrafter = r.pubsub.schedule('every 24 hours').onRun(async (context) => {
  await runAgenticDrafter();
});

export const weeklyForumPinning = r.pubsub.schedule('every 168 hours').onRun(async (context) => {
  await runWeeklyPinning();
});

// ---------------- Readiness Scoring (Concern) ----------------
// Callable: returns readiness score & recommendations for a concern (no mutations)
export const concernReadiness = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { concernId } = data as { concernId?: string };
  if (!concernId) throw new functions.https.HttpsError('invalid-argument','concernId required');
  try {
    const result = await evaluateConcernReadiness(concernId);
    return { ok: true, concernId, ...result };
  } catch (e:any) {
    if (e.message === 'concern_not_found') throw new functions.https.HttpsError('not-found','Concern not found');
    throw new functions.https.HttpsError('internal','Evaluation failed');
  }
});

export const concernReadinessHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','GET, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    try { await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const concernId = (req.query.concernId as string) || '';
    if (!concernId) { res.status(400).json({ error: 'concernId required' }); return; }
    try {
      const result = await evaluateConcernReadiness(concernId);
      res.json({ ok: true, concernId, ...result });
    } catch (e:any) {
      if (e.message === 'concern_not_found') { res.status(404).json({ error: 'Concern not found' }); return; }
      res.status(500).json({ error: 'Evaluation failed' });
    }
  } catch (e:any) { res.status(500).json({ error: e.message || 'Internal error' }); }
});

// ---------------- Concern Structure Update (Objectives / Constraints / Open Questions) ----------------
// Allows an authenticated user who created the concern OR an admin to attach structured arrays.
// Firestore mutation: merges { objectives: string[]|null, constraints: string[]|null, openQuestions: string[]|null }

export const updateConcernStructure = r.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in');
  const { concernId, objectives, constraints, openQuestions } = data as { concernId?: string; objectives?: any; constraints?: any; openQuestions?: any };
  if (!concernId) throw new functions.https.HttpsError('invalid-argument','concernId required');
  const db = admin.firestore();
  const ref = db.collection('concerns').doc(concernId);
  const snap = await ref.get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found','Concern not found');
  // Authorization: creator or admin
  let allowed = false;
  const cData = snap.data() as any;
  if (cData.createdBy && cData.createdBy === context.auth.uid) allowed = true;
  if (!allowed) {
    const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
    if (adminDoc.exists) allowed = true;
  }
  if (!allowed) throw new functions.https.HttpsError('permission-denied','Not allowed');
  const normObjectives = normalizeStringArray(objectives, 8, 160);
  const normConstraints = normalizeStringArray(constraints, 8, 160);
  const normOpen = normalizeStringArray(openQuestions, 10, 160);
  await ref.set({
    objectives: normObjectives || admin.firestore.FieldValue.delete(),
    constraints: normConstraints || admin.firestore.FieldValue.delete(),
    openQuestions: normOpen || admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await logEvent({ event: 'updateConcernStructure', uid: context.auth.uid, refId: concernId, data: { objectives: (normObjectives||[]).length, constraints: (normConstraints||[]).length, openQuestions: (normOpen||[]).length } });
  return { ok: true, counts: { objectives: (normObjectives||[]).length, constraints: (normConstraints||[]).length, openQuestions: (normOpen||[]).length } };
});

export const updateConcernStructureHttp = r.https.onRequest(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary','Origin');
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Access-Control-Allow-Credentials','true');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')? authHeader.slice(7): null;
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }
    let decoded: admin.auth.DecodedIdToken; try { decoded = await admin.auth().verifyIdToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
    const body = typeof req.body === 'object' ? req.body : {};
    const { concernId, objectives, constraints, openQuestions } = body;
    if (!concernId) { res.status(400).json({ error: 'concernId required' }); return; }
    const db = admin.firestore();
    const ref = db.collection('concerns').doc(concernId);
    const snap = await ref.get(); if (!snap.exists) { res.status(404).json({ error: 'Concern not found' }); return; }
    let allowed = false; const cData = snap.data() as any;
    if (cData.createdBy && cData.createdBy === decoded.uid) allowed = true;
    if (!allowed) { const adminDoc = await db.collection('admins').doc(decoded.uid).get(); if (adminDoc.exists) allowed = true; }
    if (!allowed) { res.status(403).json({ error: 'Not allowed' }); return; }
    const normObjectives = normalizeStringArray(objectives, 8, 160);
    const normConstraints = normalizeStringArray(constraints, 8, 160);
    const normOpen = normalizeStringArray(openQuestions, 10, 160);
    await ref.set({
      objectives: normObjectives || admin.firestore.FieldValue.delete(),
      constraints: normConstraints || admin.firestore.FieldValue.delete(),
      openQuestions: normOpen || admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await logEvent({ event: 'updateConcernStructure', uid: decoded.uid, refId: concernId, data: { objectives: (normObjectives||[]).length, constraints: (normConstraints||[]).length, openQuestions: (normOpen||[]).length } });
    res.json({ ok: true, counts: { objectives: (normObjectives||[]).length, constraints: (normConstraints||[]).length, openQuestions: (normOpen||[]).length } });
  } catch (e:any) { res.status(500).json({ error: e.message || 'Internal error' }); }
});

