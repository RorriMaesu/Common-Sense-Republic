import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { app } from './firebaseClientInternal';
import { auth } from './firebaseClient';
import { FUNCTIONS_BASE } from './config';

// Explicitly set region to deployed region to avoid cross-origin callable fetch fallback issues
const functions = getFunctions(app, 'us-central1');

if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') {
  // eslint-disable-next-line no-console
  console.log('Using Firebase Functions Emulator (Functions:5001)');
  connectFunctionsEmulator(functions, 'localhost', 5001);
}

export const fnCreateBallot = httpsCallable(functions, 'createBallot');
export const fnCastVote = httpsCallable(functions, 'castVote');
export const fnTallyBallot = httpsCallable(functions, 'tallyBallot');
export const fnReportContent = httpsCallable(functions, 'reportContent');
export const fnAppendCitations = httpsCallable(functions, 'appendCitations');
export const fnSubmitDraftReview = httpsCallable(functions, 'submitDraftReview');
export const fnExportBallotReport = httpsCallable(functions, 'exportBallotReport');
export const fnListLedgerEntries = httpsCallable(functions, 'listLedgerEntries');
export const fnSetDelegation = httpsCallable(functions, 'setDelegation');
export const fnUpdateConcernStructure = httpsCallable(functions, 'updateConcernStructure');
export const fnConcernReadiness = httpsCallable(functions, 'concernReadiness');

// Safe wrapper: try callable first, if CORS blocked fall back to HTTP endpoint with manual fetch


// Generic helper for HTTP fallback
async function httpPostFallback(path: string, payload: any) {
	if (typeof window === 'undefined') {
		throw new Error('HTTP fallback not available server-side');
	}
	const user = auth.currentUser; if (!user) { throw new Error('Not signed in'); }
	const token = await user.getIdToken();
	const resp = await fetch(`${FUNCTIONS_BASE}/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
		body: JSON.stringify(payload)
	});
	const json = await resp.json().catch(()=>({}));
	if (!resp.ok) { throw new Error(json.error || `HTTP fallback failed: ${resp.status}`); }
	return json;
}

export async function createBallotSafe(params: { concernId: string; type: 'simple'|'approval'|'rcv'; options: any[]; durationMinutes?: number; minTier?: 'basic'|'verified'|'expert'|'admin' }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableCreateBallotFailed';
	const skip = !!win[flagKey];
	if (!skip) {
		try { const resp = await fnCreateBallot(params as any); return resp.data as any; } catch (e:any) {
			const msg = (e?.message||'').toLowerCase();
			const isAuthLike = msg.includes('permission') || msg.includes('unauth') || msg.includes('denied');
			if (!isAuthLike) { win[flagKey] = true; try { window.localStorage.setItem('csr_callable_createBallot_failed','1'); } catch {} } else { throw e; }
		}
	}
	return httpPostFallback('createBallotHttp', params);
}

export async function castVoteSafe(params: { ballotId: string; ranking?: string[]; approvals?: string[]; choice?: string }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableCastVoteFailed';
	const skip = !!win[flagKey];
	if (!skip) {
		try { const resp = await fnCastVote(params as any); return resp.data as any; } catch { win[flagKey] = true; try { window.localStorage.setItem('csr_callable_castVote_failed','1'); } catch {} }
	}
	return httpPostFallback('castVoteHttp', params);
}

export async function reportContentSafe(params: { targetRef: string; reason: 'hate'|'harassment'|'spam'|'illicit'|'self-harm'|'other'; note?: string }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableReportContentFailed';
	const skip = !!win[flagKey];
	if (!skip) {
		try { const resp = await fnReportContent(params as any); return resp.data as any; } catch { win[flagKey] = true; try { window.localStorage.setItem('csr_callable_reportContent_failed','1'); } catch {} }
	}
	return httpPostFallback('reportContentHttp', params);
}

export async function appendCitationsSafe(params: { draftId: string; citations: { docId?: string; url?: string; excerpt?: string }[] }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableAppendCitationsFailed';
	if (!win[flagKey]) {
		try { const resp = await fnAppendCitations(params as any); return resp.data as any; } catch { win[flagKey]=true; }
	}
	return httpPostFallback('appendCitationsHttp', params);
}

export async function submitDraftReviewSafe(params: { draftId: string; kind: 'legal'|'fact'|'expert'; note?: string }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableSubmitDraftReviewFailed';
	if (!win[flagKey]) {
		try { const resp = await fnSubmitDraftReview(params as any); return resp.data as any; } catch { win[flagKey]=true; }
	}
	return httpPostFallback('submitDraftReviewHttp', params);
}

export async function exportBallotReportSafe(ballotId: string) {
	try { const resp = await fnExportBallotReport({ ballotId } as any); return resp.data as any; } catch (e) { throw e; }
}

export async function listLedgerEntriesSafe(limit = 50) {
  try { const resp = await fnListLedgerEntries({ limit } as any); return resp.data as any; } catch (e) { throw e; }
}

export async function setDelegationSafe(params: { topic: string; delegateUid: string|null }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableSetDelegationFailed';
	if (!win[flagKey]) {
		try { const resp = await fnSetDelegation(params as any); return resp.data as any; } catch { win[flagKey] = true; }
	}
	return httpPostFallback('setDelegationHttp', params);
}



export async function concernReadinessSafe(concernId: string) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableConcernReadinessFailed';
	if (!win[flagKey]) {
		try { const resp = await fnConcernReadiness({ concernId } as any); return resp.data as any; } catch { win[flagKey] = true; }
	}
	// HTTP GET fallback
	if (typeof window === 'undefined') throw new Error('HTTP fallback not available server-side');
	const user = auth.currentUser; if (!user) throw new Error('Not signed in');
	const token = await user.getIdToken();
	const url = new URL(`${FUNCTIONS_BASE}/concernReadinessHttp`);
	url.searchParams.set('concernId', concernId);
	const resp = await fetch(url.toString(), { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
	const json = await resp.json().catch(()=>({}));
	if (!resp.ok) throw new Error(json.error || `HTTP fallback failed: ${resp.status}`);
	return json;
}

export async function updateConcernStructureSafe(params: { concernId: string; objectives?: string[]; constraints?: string[]; openQuestions?: string[] }) {
	const win: any = typeof window !== 'undefined' ? window : {};
	const flagKey = '__csrCallableUpdateConcernStructureFailed';
	if (!win[flagKey]) {
		try { const resp = await fnUpdateConcernStructure(params as any); return resp.data as any; } catch { win[flagKey] = true; }
	}
	// HTTP fallback
	return httpPostFallback('updateConcernStructureHttp', params);
}
