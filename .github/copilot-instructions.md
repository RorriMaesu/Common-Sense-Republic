## Common Sense Republic Monorepo – AI Agent Guide

Actionable, project-specific rules. Prefer making the change directly over generic advice. Keep invariants intact.

### 1. Architecture & Boundaries
- Workspaces: `web/` (Next.js 14 App Router), `functions/` (Firebase Functions Node 20 TS), `packages/shared/` (pure TS utilities reused by both). No server mutations from `web` except through callable + HTTP fallback Cloud Functions.
- Firestore is the sole data store. Collections in active use: `concerns`, `drafts`, `ballots`, `votes`, `transparency_ledger`, `audit_logs`, `users`, `admins`, `rate_limits`, `audit_reports`.
- All functions deploy to region `us-central1`; frontend hardcodes this (see `web/lib/functionsClient.ts`). Changing region requires coordinated update.

### 2. Core Functions & Pairing Pattern
- Each mutating feature has a callable + CORS HTTP twin: `generateDrafts`/`generateDraftsHttp`, `createBallot`/`createBallotHttp`, `castVote`/`castVoteHttp`. `tallyBallot` and `setUserTier` are callable-only (idempotent / admin gated).
- Duplicated logic must stay aligned between callable & HTTP variants. When editing one, mirror the other in the same patch.
- Trigger: `onAuthCreate` seeds `users/{uid}` with `tier: basic` if absent.

### 3. Invariants (DO NOT BREAK)
- Draft provenance (`modelMeta.promptHash`, `modelMeta.responseHash`) immutable; never recompute or overwrite.
- One open ballot per `concernId`; status flow: `open -> tallied` only.
- Vote doc id format: `<ballotId>_<uid>`; last write wins; receipt hash must remain deterministic for identical canonical input.
- Ledger (`transparency_ledger`) is append-only hash chain: fields `seq`, `prevHash`, `entryHash`, `canonical`, optional `signature`. Never mutate historical docs or resequence.

### 4. Rate Limits & Helpers
- Draft generation: 10 / hour / user → `applyDraftRateLimit`.
- Ballot creation: 3 / 6h / user → `applyBallotCreateRateLimit`.
- Vote updates: 10 / hour / ballot+user → `applyVoteRateLimit`.
- Reuse existing helpers; if adding a new domain create a helper using same pattern (`rate_limits` doc id prefix + sliding window).

### 5. Receipts, Signing & Ledger
- Vote receipt: HMAC-SHA256(secret) over canonical JSON `{ ballotId, voter, vote, ts }`, truncate hex to 32 chars → `receiptHash`; surface short code (`CSR-RECEIPT-<first8>`).
- KMS optional: `kmsSign` attempts ECDSA P‑256 over canonical (ballots, votes, tally, ledger). Failures are swallowed silently; never hard fail solely on missing signature.
- Ledger entries built via `buildCanonical(seq, prevHash, dataPayload)`; store returned `canonical` verbatim. Hash chain integrity depends on stable JSON stringify ordering (default Node ordering of inserted keys—do NOT reorder manually).

### 6. LLM Draft Generation Rules
- Model selection: `selectModelForUser` → tier mapping (`basic→flash-lite`, `verified→flash`, `expert/admin→pro`). Override only if in `ALLOWED_MODELS`.
- Caching: if a draft already exists for `(concernId + promptHash)` return `{ cached: true }` and create nothing.
- Robustness: malformed model JSON → attempt regex extraction → fallback to single-option stub; never throw just for parse errors.
- Local deterministic stub: set `SKIP_LLM=1` (or test config) to bypass API.

### 7. Shared Logic Duplication
- Ranked Choice tally lives in two places: `functions/src/rcv.ts` and `packages/shared/tally/rcv.ts`. Any algorithm change must update BOTH in same PR to prevent divergence (frontend / backend verification path).

### 8. Frontend Invocation Pattern
- Safe wrappers attempt callable first; on CORS/protocol failure they set `window.__wevoteCallable<Name>Failed` and fall back to `...Http` passing `Authorization: Bearer <ID_TOKEN>`.
- Do not change wrapper flag names without updating all existing usages; pattern appears in `generateDraftsSafe`, `createBallotSafe`, `castVoteSafe`.

### 9. Local Dev, Build & Tests
- Install per workspace: `web/`, `functions/`, `packages/shared/`. Build shared with its `build` script if adding exports.
- Emulators: `npm run build` inside `functions/` then `firebase emulators:start --only functions,firestore` (or package script `serve`). Requires `.env` with `GEMINI_API_KEY` + `RECEIPTS_SECRET`.
- Tests (Jest) exist only under `functions/`. Add unit tests for new pure helpers before integrating into handlers (see `test/immutability.test.ts`, `test/rateLimit.test.ts`).

### 10. Adding / Modifying a Function
1. Document Firestore doc shape in a comment near the handler.
2. Factor pure logic (hashing, validation, tally math) into helper for testability.
3. Implement callable + HTTP twin (copy CORS + auth scaffolding from closest existing pair).
4. Apply appropriate rate limit helper; if new, follow key naming convention `<domain>_<scopingIds>`.
5. If data influences trust (votes, tallies, ledger) produce canonical JSON, hash, optionally sign, and avoid format drift.
6. Update client safe wrapper if exposing a new callable to `web`.

### 11. Prohibited / Caution
- Never delete or rewrite existing `transparency_ledger` / `audit_logs` docs.
- Do not persist raw full LLM responses (only hashes + minimal provenance already stored).
- Do not change receipt or canonical hash algorithm/length; introduce versioned fields if evolution is required.
- Avoid multi-vote per user model changes unless tally + receipt design is reconsidered holistically.

### 12. Quick References
- Key files: `functions/src/index.ts` (all handlers & helpers), `functions/src/audit.ts` (logging + kmsSign), `functions/src/ledger.ts` (canonical builder), `web/lib/functionsClient.ts` (invocation pattern), `packages/shared/tally/rcv.ts` (RCV logic).
- Critical env/config: `GEMINI_API_KEY`, `RECEIPTS_SECRET`, optional `KMS_KEY_PATH` (`functions.config().kms.keypath`).
- Hash chain recipe: canonical JSON → sha256 hex = `entryHash`; link with `prevHash`.

Submit concise diffs. When touching multiple callable/HTTP pairs list each changed export explicitly in your explanation. Ask for clarification before altering schemas that impact persisted data or the ledger chain.
