# Common Sense Republic (CSR)

### A Decentralized, Direct Digital Democracy Platform Built to Replace Politicians with Transparent, Auditable, and Locally-Run/Verified AI.

Common Sense Republic is a prototype for a direct digital democracy where citizens debate, refine, and vote on legislation directly. By using local and verified AI models to aggregate community concerns, compile robust policy options, draft formal bills, and run secure, verifiable liquid voting (including RCV, approval voting, and cryptographic receipts), CSR aims to build a public square that is fully auditable, highly secure, and immune to political corruption.

> Public Repository: https://github.com/RorriMaesu/Common-Sense-Republic

**Live Beta:** https://wevote-5400a.firebaseapp.com

<div align="center">

[![Support Common Sense Republic Development](web/public/support-coffee.svg)](https://buymeacoffee.com/rorrimaesu "Buy Me a Coffee – support hosting & model costs")

</div>

If you're reading this from a local clone acquired elsewhere, please pull updates and submit issues/PRs via the GitHub repository above. Do **not** commit any real API keys, KMS key paths, receipt secrets, or production Firebase config values. Use the provided `.env.example` placeholders.

## Monorepo Structure

- `web/` – Next.js 14 (App Router) frontend + Tailwind
- `functions/` – Firebase Cloud Functions (TypeScript, region `us-central1`)
- `packages/shared/` – Shared pure TypeScript utilities (e.g. ranked choice tally logic)
- Root: Firestore rules / indexes, repo-level config

## Implemented Feature Matrix (Snapshot)

| Domain | Status | Notes |
|--------|--------|-------|
| Draft Generation (Flash-Lite tier mapping) | ✅ | Caching via `(concernId + promptHash)` prevents duplicates |
| Voting (simple, approval, RCV) | ✅ | Deterministic tie-break + exhausted count tracking |
| Vote Receipts | ✅ | HMAC-SHA256 truncated to 32 hex + short code `CSR-RECEIPT-<first8>` |
| Transparency Ledger | ✅ | Append-only hash chain (`transparency_ledger`) with optional KMS signature |
| Prompt Library Export | ✅ | Callable + HTTP twin enumerating prompt versions + hashes |
| Receipt Verification | ✅ | `verifyReceipt` callable + HTTP returns non-identifying vote proof |
| Public Audit Mirror | ✅ | `audit_public` sanitized tally+rounds mirror |
| Chat Assistant (Concern Chat + Rolling Summary) | ✅ | Injection guard, JSON action allowlist, moderation heuristics, rate limits |
| Concern Readiness Scoring | ✅ | Composite (drafts, expert review, citations, distinctiveness, structure) callable+HTTP |
| Structured Concern Fields (objectives / constraints / open questions) | ✅ | Creator/admin gated update function + normalization |
| Rate Limits | ✅ | Drafts (10/hr/user), Ballot creation (3/6h/user), Vote updates (10/hr/user+ballot), Chat msgs (config) |
| Edit History / Citations Append Functions | ✅ | Append-only via server; client cannot mutate arrays directly |
| Delegation Scaffold | ✅ (basic) | Data structure + setter; no weighted tally integration yet |
| KMS Signing (optional) | ⚙️ Fallback | Graceful fallback if KMS key absent |
| Region / Tier Eligibility Enforcement | ⏳ | Tier gating present; geographic gating pending |
| Receipt Verification Endpoint | ⏳ | Planned callable `verifyReceipt` |
| Public Audit Subset Collection | ⏳ | To create `audit_public` mirror |
| RAG + Pro Drafting Pipeline | 🚧 | Design present; ingestion & retrieval not yet implemented |

Legend: ✅ complete, ⚙️ optional / graceful, ⏳ planned, 🚧 in progress.

## Cloud Functions (Callable + HTTP Twins)

Implemented pairs follow naming `<name>` and `<name>Http` for fallback when callable protocol fails (CORS / network). Current exported set (summary):

- `generateDrafts` / `generateDraftsHttp`
- `createBallot` / `createBallotHttp`
- `castVote` / `castVoteHttp`
- `chatSend` / `chatSendHttp` (assistant message send + structured actions)
- `chatConcern` / `chatConcernHttp` (legacy / fetch conversation)
- `summarizeConcern` / `summarizeConcernHttp` (rolling summary compression)
- `exportPromptLibrary` / `exportPromptLibraryHttp`
- `appendDraftEditHistory` / `appendDraftEditHistoryHttp`
- `appendCitations` / `appendCitationsHttp`
- `submitDraftReview` / `submitDraftReviewHttp`
- `setDelegation` / `setDelegationHttp`
- `verifyReceipt` / `verifyReceiptHttp`
- `concernReadiness` / `concernReadinessHttp`
- `updateConcernStructure` / `updateConcernStructureHttp`

Callable-only (no direct public HTTP twin) where appropriate: `tallyBallot`, `setUserTier` (admin), `listLedgerEntries`.

All mutating logic keeps invariants: prompt & response hashes immutable, ledger append-only, one open ballot per concern, vote doc id pattern `<ballotId>_<uid>`.

## Assistant & Chat Hardening

Security layers applied to chat / generation endpoints:

1. Prompt versioning & hashing (`promptHash` captured in modelMeta)
2. Injection guard delimiters + allowlist of structured actions (currently only `generate_drafts`)
3. JSON action suggestion parser with strict schema + safe fallback
4. Rolling summary compression to cap context size (approx char budget) while retaining latest turns
5. Moderation heuristics (PII email/phone + disallowed tokens list) – flagged content truncated / annotated
6. Rate limiting (per user + per concern for chat) – prevents flooding
7. Output parsing resilience: malformed JSON → regex extraction → single-option stub fallback

## Rate Limits (Enforced in Functions)

| Action | Limit | Helper |
|--------|-------|--------|
| Draft generation | 10 / hour / user | `applyDraftRateLimit` |
| Ballot creation | 3 / 6h / user | `applyBallotCreateRateLimit` |
| Vote (create/update) | 10 / hour / (ballot+user) | `applyVoteRateLimit` |
| Chat message send | (configurable; default moderate) | `applyChatRateLimit` (if present) |

Helpers store sliding window state in `rate_limits` collection; identical naming pattern to simplify future domains.

## Transparency Ledger

`transparency_ledger` forms a hash chain:
- `seq` incremental integer
- `prevHash` previous entry's `entryHash`
- `entryHash` SHA-256 of canonical JSON
- `canonical` stored canonical JSON string (key order preserved as inserted)
- `signature` optional (ECDSA P-256 via KMS; absent OK)

Verification (client): sequential fetch ordered by `seq`, re-hash each `canonical`, check linkage. A failure → chain invalid banner.

## Cryptographic Vote Receipts

Canonical receipt payload JSON shape: `{ ballotId, voter, vote, ts }` → HMAC-SHA256(secret) → hex truncated 32 chars = `receiptHash`; user-facing code `CSR-RECEIPT-<first8>`. Deterministic for identical canonical values (replay safe because timestamp included).

## Prompt Library & Version Transparency

`exportPromptLibrary` returns list of prompts with: `id`, `version`, `templateHash`, `preview`, and deployment timestamp. Frontend surfaces these in the Transparency Hub so external auditors can compare prompt semantic drift over time.

## Firestore Security Model (Implemented)

Key enforced invariants (rules + server logic):
- `modelMeta.promptHash` & `modelMeta.responseHash` immutable once set.
- Arrays `editHistory`, `citations`, `reviews` not client-writable (server append only).
- Vote documents private (read disallowed); tallies & audit exports provide aggregate visibility.
- Ledger entries append-only; no resequencing or mutation allowed.
- Ballot lifecycle: `open -> tallied` (no reopen or deletion that affects history).

## Testing

Jest tests (in `functions/test`) cover: tally determinism, rate limits, immutability guards, prompt library integrity, moderation heuristics, action parsing, summary compression, readiness scoring, concern structure normalization, delegation, ledger chain integrity.

Current count: 26 suites / 62 tests (will grow as features expand).

Run all tests:
```bash
cd functions
npm test
```

Add pure helpers first with unit tests before wiring into handlers (pattern followed in existing modules).

## Local Development

1. Install deps (root packages individually):
```bash
cd web && npm install
cd ../functions && npm install
cd ../packages/shared && npm install && npm run build
```
2. (Optional) Start emulators:
```bash
firebase emulators:start --only functions,firestore
```
3. Run web dev server (separate shell):
```bash
cd web && npm run dev
```

## Environment & Secrets

Environment resolution order (for functions):
1. Runtime config (`functions.config()`) – legacy, will migrate off before deprecation
2. Process env (`process.env.*`) – loaded from `.env` during emulator runs

Currently used keys:
- `gemini.key` or `GEMINI_API_KEY` – LLM access
- `receipts.secret` or `RECEIPTS_SECRET` – HMAC receipts fallback if no KMS
- `kms.keypath` or `KMS_KEY_PATH` – optional signing key path
- `SKIP_LLM=1` – deterministic stub responses for local fast tests

Never check real values into version control. All sensitive runtime configuration stays in Firebase Functions config (`firebase functions:config:set`) or local untracked `.env` files.

Planned migration: move secrets to Google Secret Manager + parameterize via new Functions runtime API when stable.

## Deployment

Functions only:
```bash
firebase deploy --only functions
```

Rules only:
```bash
firebase deploy --only firestore:rules
```

Full (Hosting + Functions + Rules):
```bash
firebase deploy
```

Ensure Hosting deploy step included for frontend changes; missing Hosting deploy is a common source of “stale UI” confusion.

## Troubleshooting Quick Reference

| Symptom | Likely Cause | Resolution |
|---------|--------------|-----------|
| Frontend not showing new functions | Hosting not redeployed | Run full deploy including Hosting |
| `Invalid function name: slice` in rules compile | Unsupported rules attempt (e.g. array slice) | Replace with server-enforced append-only pattern |
| Repeated draft creation for same prompt | Caching bypassed due to prompt change | Confirm stable prompt template & hashing |
| Missing signatures in ledger | KMS key not configured | Configure `kms.keypath` or ignore (optional) |

## Roadmap (High Priority Next)

1. Public audit mirror (`audit_public`) with redacted fields
2. RAG ingestion pipeline + Pro drafting flow (citations, provenance expansion)
3. Delegated vote weighting integration into tally (versioned tally algorithm)
4. CI/CD GitHub Actions pipeline (lint, test, deploy staging → manual prod gate)
5. Secret Manager + config migration (functions.config() deprecation prep)
6. Streaming assistant responses (progressive render)
7. Advanced editor suggestion mode & version diff viewer
8. Reputation & reviewer trust scoring influencing feed ranking

---
Below are legacy setup details (retained, updated) plus extended transparency sections.

## Getting Started (Extended)

Prereqs: Node 18+, pnpm or npm, Firebase CLI.

1. Install deps
```bash
cd web && npm install
cd ../functions && npm install
```
2. (Optional) Enable emulators & run
```bash
firebase emulators:start --only functions,firestore
```
3. Run web dev server
```bash
cd web && npm run dev
```

## Gemini API Key & Model Configuration (LLM Draft Generation)

The draft generation functions look up the Gemini key in this order:
1. `functions.config().gemini.key` (Firebase Functions runtime config – production recommended)
2. `process.env.GEMINI_API_KEY` (environment variable – local/emulator fallback)

### 1. Set the Key in Firebase (Production / Staging)
This persists an encrypted runtime config value (NOT in source control):

PowerShell (Windows):
```
firebase functions:config:set gemini.key='YOUR_GEMINI_API_KEY'
```
macOS/Linux (bash/zsh):
```
firebase functions:config:set gemini.key="YOUR_GEMINI_API_KEY"
```
Optional: set a default model override (not required because tier logic already maps tiers → model):
```
firebase functions:config:set gemini.model='gemini-2.5-flash'
```
Deploy to apply:
```
firebase deploy --only functions
```
Verify it’s stored:
```
firebase functions:config:get | grep gemini
```

### 2. Local Development (Emulators)
Create `functions/.env` (NOT committed) or export the variable in your shell:
```
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```
Firebase CLI will automatically load `functions/.env` when running emulators (`firebase emulators:start`) or during deploy for build-time environment variables.

Alternatively, set per session (PowerShell):
```
$env:GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
```

### 3. Model Variants & Tier Mapping
The function auto-selects a model based on the user’s tier:
- basic → gemini-2.5-flash-lite
- verified → gemini-2.5-flash
- expert/admin → gemini-2.5-pro

You can request a specific variant (if allowed) from the client:
```ts
await generateDraftsSafe({ concernId, variant: 'gemini-2.5-pro' });
```
(Will fall back to tier default if not permitted / not whitelisted.)

### 4. Rotating the Key
1. Add new key: `firebase functions:config:set gemini.key='NEW_KEY'`
2. (Optional) Keep old key available briefly by storing it separately (code could be extended to check `gemini.oldkey`).
3. Deploy: `firebase deploy --only functions`
4. Revoke old key in Google AI Studio after confirming traffic works.

### 5. (Optional) Use Secret Manager Instead
For higher assurance you can store the API key in Google Secret Manager and inject it at deploy/build time. Current code expects either runtime config or env var; to use Secret Manager you can (future enhancement):
1. Create secret: `gcloud secrets create GEMINI_API_KEY --data-file=key.txt`
2. Grant access to the Functions service account.
3. In `functions/package.json` add a prestart script to read the secret and export it, or use the new `--set-secrets` deployment flag (2nd Gen functions feature).

### 6. Troubleshooting 500 / CORS Errors
| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `500` with `{ error: 'Gemini key not configured' }` | Key not set in config or env | Set config or env var then redeploy |
| `Gemini error: 403 ... permission` | Key invalid / revoked | Regenerate key in AI Studio |
| CORS preflight failure on callable | Browser edge / callable protocol | Fallback HTTP endpoint (`generateDraftsHttp`) now added |
| Always returns cached=0 but no drafts appear | Firestore security rules blocking writes | Check Functions logs & Firestore rules |
| Rate limit error (`resource-exhausted`) | >10 generations/hour per user | Wait or raise limit logic |

To view detailed server errors: Firebase Console → Functions → Logs → filter for `generateDrafts` or `generateDraftsHttp`.

### 7. Safety & Output Validation
We currently omit `safetySettings` for speed; you can add them if policy requires. Output JSON is parsed; if malformed, we fallback to a single option stub so the app doesn’t break.

### 8. Summary
Set key in Functions config for production, `.env` for local. Deploy. Confirm logs. Use variant parameter or rely on automatic tier mapping.

## Cryptographic Receipts & KMS Signing (Phase 1 Trust)
## Transparency Ledger (Phase 1.5)

Each finalized ballot tally is now appended to an immutable, hash‑chained ledger stored in Firestore collection `transparency_ledger`:

Canonical entry structure (before hashing):

```
{ "seq": N, "prevHash": "<hex or null>", "data": { "kind": "tally", "ballotId": "...", "results": { ... }, "ts": 1730000000000 } }
```

`entryHash = sha256(JSON.stringify(canonical))`

Fields stored:
- `seq` incremental sequence number (starts at 1)
- `prevHash` previous entry's `entryHash` (null for first)
- `entryHash` current hash
- `canonical` stored canonical JSON string
- `signature` optional KMS signature (base64, DER ECDSA P-256)
- `data.results` mirrors tally results already embedded in ballot doc

Verification steps (client):
1. Fetch entries ordered by `seq`.
2. Recompute sha256 of each `canonical`, compare to `entryHash`.
3. Ensure `prevHash` of each matches `entryHash` of prior.
4. (Optional) Verify `signature` using published public key from `public/signing-key.pem` if KMS configured.

If any link or hash fails, mark chain invalid. The `/verify` page provides an in-browser verifier prototype.

### Exporting the Public Key
## Concern Readiness & Structured Fields

Readiness scoring (`concernReadiness` / `concernReadinessHttp`) returns:
```
{ ok: true, concernId, score: 0-100, components: { drafts, expert, citations, distinct, summary }, missing: string[], recommendations: string[], version }
```
Weights (v1): drafts 30, expert 30, citations 15, distinctiveness 20, summary fields 5.

Structured fields are optional but boost readiness and user clarity:
- `objectives[]` (max 8, 160 chars each)
- `constraints[]` (max 8, 160 chars each)
- `openQuestions[]` (max 10, 160 chars each)

Update via callable `updateConcernStructure` (or HTTP twin) – only concern creator or admin. Empty / invalid entries are pruned; if a list becomes empty it’s deleted to avoid stale empty arrays.

Frontend displays provenance badges per draft: model name (or Fallback) + short `promptHash`/`responseHash` fragments to support trust & diffing.

```
gcloud kms keys versions get-public-key 1 \
	--location=global --keyring=wevote-core --key=wevote-signing \
	--format='value(pem)' > web/public/signing-key.pem
```
Commit (or deploy) the public key only if you are comfortable making it public (it should be a verify-only key). Never expose private keys.


Receipts and tally signatures use a hybrid approach:
- If a Cloud KMS key is configured, receipts/tallies are signed with it and the signature recorded.
- Otherwise an HMAC (shared secret) fallback is used.

Configure secrets:
```
firebase functions:config:set receipts.secret="LOCAL_FALLBACK_SECRET"
firebase functions:config:set kms.keypath="projects/WEVOTE_PROJECT/locations/global/keyRings/wevote-core/cryptoKeys/wevote-signing/cryptoKeyVersions/1"
```
Provision key (example):
```
gcloud kms keyrings create wevote-core --location=global
gcloud kms keys create wevote-signing \
	--location=global --keyring=wevote-core \
	--purpose=asymmetric-signing --default-algorithm=EC_SIGN_P256_SHA256
```
Then deploy functions again.

## Tier & Admin Bootstrap

Ballot creation is restricted to users with tier `verified`, `expert`, or `admin`.
Workflow:
1. Deploy functions & rules.
2. Sign in with a seed user (creates `/users/{uid}` via auth trigger if implemented later).
3. In Firestore console create doc `admins/{uid}` for that user (empty object is fine).
4. Call callable `setUserTier` (to be added) to elevate tier, or set custom claims via admin script.

## Firestore Rules Hardening

Rules lock down:
- `drafts`: provenance & model metadata immutable after creation.
- `votes`: fully private (only aggregated tallies exposed).
- `audit_logs`, `admins`: server-only.
- `users`: self-read/update without tier escalation.

## (Superseded) Prior TODO Snapshot
Historical list kept for context; see Roadmap above for current source of truth.

## Deploy
### Deploy (Functions Only)
```bash
firebase deploy --only functions
```

### Deploy (Web + Functions with Next.js SSR on Firebase Hosting)
Framework-aware Hosting (preview) or App Hosting can serve the Next.js (App Router) SSR pages.

1. Ensure CLI >= 12.1.0:
```bash
firebase --version
```
2. (Preview path) Enable frameworks experiment if not using App Hosting yet:
```bash
firebase experiments:enable webframeworks
```
3. Deploy everything:
```bash
firebase deploy
```

The CLI detects `web/next.config.*` + `package.json` and outputs a Cloud Function for SSR plus static assets.

### Environment Variables for SSR
Use `.env.local` inside `web/` for variables that Next server can access, and `NEXT_PUBLIC_*` for client. Sensitive server-only values can also be stored in Functions config and read via callable functions / APIs.

### Migrating Later to Firebase App Hosting (Optional)
App Hosting combines SSR + CDN + build orchestration with GitHub integration and is recommended long-term. This repo currently targets the frameworks integration; migration would mainly involve running:
```bash
firebase experiments:enable apphosting
firebase init apphosting
```
Then following prompts to map the `web` directory.

## Next Steps
- [x] Gemini draft generation callable (`generateDrafts`) with prompt & response hashing
- [ ] Add provenance & prompt hashing
- [ ] Expand security rules per design doc (tiers, vote protections)
- [ ] Add RCV tally Cloud Run service & connect ballots
- [ ] Add moderation queue & admin console

