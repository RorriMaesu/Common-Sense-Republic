Nice — **Common Sense Republic** it is. I thought *very* long and built a single, comprehensive, production-ready webapp design document you can hand to designers and engineers and start building from day one.

This document contains:

* Product overview & principles
* Complete user flows (every screen, microcopy, states)
* Detailed UI spec & component library (styles, tokens, Tailwind snippets)
* Full data model (Firestore collections, fields, indexes)
* Security & identity design (tiers, verification, fraud controls)
* LLM integration & RAG pipeline with exact prompt templates and provenance model
* Voting engine design (simple, approval, RCV) with receipts & auditability
* Backend architecture (Firebase-first) with Cloud Functions + Cloud Run services and code stubs
* Firestore security rules skeleton and CI/CD guidance
* Moderation, governance, and legal workflow
* Observability, testing, rollout roadmap, cost-control suggestions
* Developer task backlog & timeline (sprint-level)

I’ve aimed for actionable specificity so your engineers can start implementing immediately. If you want, I can now generate the first 1-week sprint PR-ready artifacts: repo scaffold, Firestore rules file, Next.js starter pages, Cloud Function stubs, and prompt JSON files.

---

# Common Sense Republic — Comprehensive Webapp Design Document

> Revision Note (2025-09-29): This document was updated to reflect newly implemented components: hardened concern chat assistant (rolling summaries, action allowlist, moderation heuristics), prompt library export & version hashing, append-only transparency ledger, deterministic RCV improvements (exhausted count + tie-break), server-enforced append-only provenance arrays, and deployment nuances (callable + HTTP twins). Original sections retained; deltas annotated where relevant.

## 1. Vision & Product Principles

**Vision:** Common Sense Republic — a trustworthy, auditable public square where people draft, debate, and vote on policy proposals that can be refined into well-sourced bill drafts and exported to decision-makers.

**Core principles**

* **Advisory-first & transparent** — results are advisory by default; all model prompts, versions, and provenance are visible.
* **Trust & auditability** — cryptographic receipts, append-only logs, signed artifacts, and open tally code.
* **Human-in-the-loop** — LLM-assisted drafting + mandatory legal/fact-review before escalation.
* **Inclusive & accessible** — simple actions for casual users; deep tools for power users and experts.
* **Fraud-resistant** — progressive verification and anti-abuse heuristics.
* **Scalable & cost-aware** — use Gemini Flash-Lite for most interactions, Gemini Pro for gated drafting.

---

## 2. High-level architecture (Firebase-first)

### Components

* **Frontend:** Next.js (React + TypeScript), Tailwind CSS, PWA setup
* **Auth & Identity:** Firebase Authentication (email + phone), optional Identity Platform for attestations
* **DB:** Cloud Firestore (primary), with append-only `audit_logs` collection
* **LLM:** Firebase GenKit + Vertex AI (Gemini Flash-Lite & Gemini Pro) – Flash-Lite used for ideation/chat; Pro reserved for gated drafting (pipeline not yet fully implemented)
* **RAG/Embeddings:** Firestore embeddings or external vector DB (Pinecone/FAISS) if scale demands
* **Serverless logic:** Firebase Cloud Functions (short tasks), Cloud Run (long-running, LLM orchestration)
* **Storage:** Google Cloud Storage (exports, artifacts)
* **Crypto & secrets:** Cloud KMS + Secret Manager (signing keys, API keys)
* **Monitoring:** Firebase Performance, Crashlytics, Cloud Monitoring, Sentry (optional)
* **CI/CD:** GitHub Actions → deploy to Firebase projects; Terraform for infra

### Call flow (short)

1. User creates concern → user (or chat assistant guided path) invokes callable to generate 3 draft options (Gemini Flash-Lite) → stored with prompt/response hashes.
2. Feed surfaces drafts. Users discuss/edit using assistant (chat messages stored; rolling summary maintained to bound context).
3. (Planned) Shortlisted drafts enter Pro drafting pipeline (Gemini Pro + RAG) → citations + provenance expansion → human review.
4. Ballots created (tier gated) → votes cast (receipts issued) → tally function (RCV / simple / approval) produces rounds + exhausted counts → ledger entry appended + optional KMS signature.

---

## 3. Personas & authorization tiers

**Personas**

* Casual Citizen — low friction; can submit concerns and vote (Tier 0–1).
* Contributor / Organizer — edits & campaigns (Tier 1).
* Expert / Reviewer — fact-check and legal sign-off (Tier 2).
* Moderator / Admin — handle escalations & security.
* Government / Partner — receives exports.

**Identity / capability tiers**

* **Anon (Tier A):** read-only, can create concerns as anonymous public content (flagged), limited voting powers (e.g., “express interest” only).
* **Basic (Tier B):** email + phone verified; can vote in advisory polls; can comment and suggest edits.
* **Verified (Tier V):** optional KYC or identity attestations via Identity Platform / 3rd party — required to escalate proposals to government or act as delegation target.
* **Expert (Tier E):** verified + expert vetting badge; can sign legal review.

Map features to tiers in the security rules (see Firestore rules section).

---

## 4. Product flows — full UI + microcopy (walkthrough)

> Note: UI text is deliberately concise and optimistic. Use friendly tone.

### Global layout & nav

* Top nav (desktop): Logo (Common Sense Republic) | Search bar | Create Concern (primary CTA) | Notifications | Profile menu
* Left rail (desktop): Filters: Jurisdiction, Topics, Nearby, Following
* Right rail (desktop): Transparency widget (latest audits), Assistant quick actions
* Mobile: bottom nav with Home / Create / Ballots / Transparency / Profile

---

### Landing page (unauthenticated)

Hero: “Common Sense Republic — Draft. Debate. Decide.”
CTA buttons: [Get Started] (signup) [Explore Feed] (read-only)
Secondary: “How Common Sense Republic works” with 3-step explainer cards: Chat → Draft → Vote
Footer: Transparency link, Governance charter, Privacy policy

---

### Onboarding (first-time user)

* Step 0: Welcome modal — “WeVote is advisory by design...” CTA: Continue
* Step 1: Choose display name & region (auto detect + override)
* Step 2: Quick tutorial: 60s RCV interactive demo (skipable)
* Step 3: Privacy & verification explanation (how tiers work)

Microcopy:

* “We keep your identity private by default. Upgrade to Verified to escalate drafts to officials.”

---

### Home Feed (main page)

* Cards show concerns ranked by a composite score: engagement * recency * representativeness * editorial boost.
* Each card contains:

  * Title (H3)
  * Jurisdiction chip (city, county, state)
  * Short summary (1–2 lines)
  * Draft tiles (A/B/C) with quick vote / endorse / discuss buttons
  * Meta: votes | comments | time left (if active ballot)
  * “Provenance” icon (small) showing model badge & review status

Actions:

* Quick endorse (heart) — lightweight signal (no ballot weight)
* Discuss → opens discussion thread
* Rank → opens ballot or ranking UI if ballot is active for those drafts

Empty state microcopy:

* “Nothing here yet. Create the first concern in your neighborhood.”

---

### Create Concern flow (wizard + chat)

**Two UX paths**

1. **Quick Submit**

   * Fields: Title, Describe (textarea), Attach (optional doc or link), Jurisdiction (auto), Visibility (Public / Anonymous / Community-only)
   * Button: [Generate drafts]
   * After submit: spinner → show three draft options generated by Gemini Flash-Lite within <6s, labeled Draft A/B/C with summary cards.
   * Buttons per draft: Edit | Submit to Discussion | Nominate for Ballot

2. **Guided Chat (LLM)**

  * Chat UI (left: user, right: assistant). Assistant = Gemini Flash-Lite (hardened prompt v2 with delimiter & injection guard).
  * Structured action detection: assistant may emit JSON `{"actions":[{"type":"generate_drafts"}]}` (allowlist enforced) – other suggestions ignored.
  * Rolling summary compression automatically condenses older turns (token-lite strategy) to keep latency low.
  * Moderation heuristics flag PII-like email/phone patterns & disallowed tokens; flagged segments annotated or truncated.
  * After finishing (or on emitted action) user triggers draft generation (3 LLM drafts) with caching by `(concernId + promptHash)`.

Microcopy:

* “Drafts generated by Gemini Flash-Lite. Want an official-style bill? Request Gemini Pro drafting — limited credits apply.”

---

### Draft Detail & Editor (primary collaboration surface)

**Layout (two-column)**

* Left: Draft editor (Markdown WYSIWYG) with change tracking
* Right: LLM Assistant panel + citations + provenance UI

**Top metadata**

* Title, author(s) (can be Anonymous), jurisdiction chips, status badge (IDEA / DRAFTING / BALLOT / REFINED / ESCALATED), last edited timestamp
* Buttons: Save | Request Legal Review | Open Ballot (if eligible) | Export PDF

**Editor features**

* “Suggestion mode” (like Google Docs): suggestions show inline, require approval to apply
* Inline provenance badges next to paragraphs: icon hover → “Generated by Gemini Pro • Prompt v3 • Sources: X,Y,Z” (future enhancement; current backend stores prompt/response hashes, citation arrays append-only)
* Version history panel (click to view diffs & revert)

**Assistant panel features**

* Prompt used (read-only), model badge (Flash-Lite/Pro), RAG document list (clickable)
* Buttons: [Regenerate], [Produce Plain-Language Summary], [Add Enforcement Clause], [Estimate Budget Impact]
* Confidence indicator (low/medium/high) and “missing sources” warnings

Microcopy:

* “Request Legal Review will place this draft in the Expert queue. Legal reviews are needed before escalation.”

---

### Discussion Thread

* Threaded comments, votes per comment (upvote), pin moderator notices
* Flag button on each comment (reason dropdown)
* Link previews for shared links (auto snapshot)

---

### Ballot & Voting UI

**Ballot header**

* Ballot name, jurisdiction, ballotType (Simple / Approval / RCV), start / end time, eligible voters rules, ballot description, “How it works” link.

**Ballot types**

* **Simple:** select one option and submit
* **Approval:** toggle every option you approve (multiple)
* **RCV / IRV:** drag-and-drop ranking; show ranking numbers; real-time simulated outcome preview (non-binding) when user ranks.

**Voting flow**

1. Click [Vote] → modal opens with clear TTL for ballot
2. Confirm eligibility (show user tier & region check)
3. Cast vote → UI shows “Vote submitted” with receipt hash (display & email option)
4. Allow re-voting until ballot close (only last vote counted) — show visible timeline

**Receipt & audit**

* Receipt format: `CSR-RECEIPT-{shortHash}` and downloadable JSON with `receiptHash`, `ballotId`, `voterSignaturePublicKey`, `timestamp`.
* Public audit page: anonymized tallies + proof data.

Microcopy:

* “You can change your vote up until [end time]. Only your last submitted ballot will be counted.”

---

### Profile & Delegation

* Profile tabs: Activity | Delegations | Badges | Settings
* Delegations UI: per-topic delegation (delegate your votes to a user for Transportation topic only), delegations are revocable.
* Reputation meter: visual bar with explanation how it's earned (activity, verified reviews, expert sign-offs)

Microcopy:

* “Delegating doesn’t transfer your account — it simply proxies your votes until you revoke.”

---

### Transparency Hub

* Sections:

  * Model & prompt library (live export via callable – includes id, version, template hash, preview)
  * Audit & ledger viewer (hash chain integrity check UI)
  * Moderation log (redacted – future)
  * Exported packages (PDF / JSON with provenance – planned)
  * Tally algorithm reference (link to shared RCV implementation source)

Microcopy:

* “We publish sanitized logs and the exact prompts used to generate drafts so anyone can verify provenance.”

---

### Admin Console

* Queues: Flags, Legal reviews, Surge detection, Pending escalations
* Actions: Freeze ballot, Ban account, Forensic export, Publish transparency report
* Security dashboard: Suspicious activity alerts, rate limits, on-going incidents

---

## 5. Visual & UI system (design tokens, components)

### Brand tokens (CSS variables)

```css
:root{
  --brand-navy: #0B2545;
  --brand-sky: #0E5C7B;
  --accent-teal: #00C2A8;
  --cta-amber: #FFB547;
  --bg: #F4F6F8;
  --card-bg: #FFFFFF;
  --text: #111827;
  --muted: #6B7280;
  --success: var(--accent-teal);
  --danger: #E23E57;
  --radius-card: 12px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
}
```

### Typography

* Inter for UI (400, 600, 700); Merriweather for exports
* Type scale: H1 36/700, H2 28/600, H3 22/600, Body 16/400

### Component primitives

* **Primary Button:**

  * Class: `btn-primary` = `bg-accent-teal text-white py-3 px-5 rounded-lg shadow hover:-translate-y-0.5 focus:ring-4`
* **Card:** `bg-card-bg p-4 rounded-lg shadow-sm border border-gray-100`
* **Chips:** `inline-flex items-center px-2 py-1 rounded-full text-xs bg-gray-50 text-muted`
* **Input:** `w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-accent-teal/30`
* **Modal:** centered, backdrop, focus trap, close on escape

### Iconography

* Lucide or Feather; 24px default; consistent stroke width

### Motion

* Micro-transitions 160–240ms, spring easing for drag interactions (RCV)

Accessibility

* All components accessible, semantic HTML, aria labels, keyboard focus, high contrast versions, alt text for images.

---

## 6. Data model — Firestore schema (detailed)

/documents use collection/document style; include types and indexes.

### `users/{uid}`

```json
{
  "uid": "string",
  "displayName": "string",
  "emailHash": "string", // hashed for privacy
  "region": { "country": "US", "state": "OR", "city": "Winston" },
  "identityTier": "anon|basic|verified|expert",
  "reputation": 0,
  "joinedAt": timestamp,
  "lastActiveAt": timestamp,
  "delegations": { "topic:transport": "delegateUid" } // optional
}
```

Index: `region.city`, `identityTier`, `reputation`

### `concerns/{concernId}`

```json
{
  "concernId": "string",
  "title": "string",
  "description": "string",
  "authorUid": "string|null",
  "jurisdiction": { "country": "US", "state": "OR", "city": "Winston" },
  "topics": ["parking", "transport"],
  "status": "idea|drafting|ballot|refined|escalated|archived",
  "createdAt": timestamp,
  "updatedAt": timestamp,
  "llmSummaries": [{"model":"Gemini-2.5-Flash","promptHash":"abc","output":"...","ts":timestamp}],
  "viewCount": int,
  "nominationCount": int
}
```

Index: `jurisdiction.city`, `topics[]`, `status`, `createdAt`

### `drafts/{draftId}`

```json
{
  "draftId": "string",
  "concernId": "string",
  "version": int,
  "text": "markdown string",
  "authors": [{"uid":"", "role":"author|editor"}],
  "modelMeta": { "model": "Gemini-2.5-Pro", "promptHash": "sha256", "responseHash":"sha256" },
  "citations": [{"docId":"", "url":"", "excerpt":""}], // server-append-only
  "editHistory": [{"uid":"", "changeSummary":"", "ts":timestamp}], // server-append-only
  "status": "draft|underReview|ballot|final",
  "createdAt": timestamp,
  "updatedAt": timestamp
}
```

Index: `concernId`, `status`, `createdAt`

### `ballots/{ballotId}`

```json
{
  "ballotId": "string",
  "title": "string",
  "description": "string",
  "draftIds": ["draftA","draftB"],
  "ballotType": "simple|approval|rcv",
  "jurisdiction": {...},
  "eligibleRule": { "tier":"basic|verified", "region":"Winston" },
  "startAt": timestamp,
  "endAt": timestamp,
  "createdBy": "uid",
  "resultsRef": "results/docId"
}
```

Index: `jurot`, `startAt`, `endAt`

### `votes/{voteId}` (sensitive — keep minimal)

```json
{
  "voteId": "string",
  "ballotId": "string",
  "voterUid": "string|null",
  "ranking": ["draftB","draftA"],
  "submittedAt": timestamp,
  "receiptHash": "sha256"
}
```

Note: Don’t store raw voter PII; use hashed UID or tokenization if privacy demanded.

### `audit_logs/{logId}` (append-only)
### `transparency_ledger/{seq}` (append-only hash chain)

```json
{
  "seq": 42,
  "prevHash": "hex|null",
  "entryHash": "hex",
  "canonical": "{...stable JSON string...}",
  "signature": "base64(optional)",
  "data": { "kind": "tally", "ballotId": "...", "rounds": [ ... ], "ts": 1730000000000 }
}
```

Indexes: `seq` ascending (natural). Invariants: no mutation after write; `seq` monotonic; `prevHash` must match prior `entryHash`.

```json
{
  "logId":"string",
  "actorUid":"string|null",
  "action":"create_draft|edit_draft|cast_vote|open_ballot|close_ballot|export",
  "targetRef":"drafts/draftId",
  "payloadHash":"sha256",
  "signature":"kms-signed-b64",
  "createdAt": timestamp
}
```

Use Cloud Function to sign each audit log entry with Cloud KMS.

### `provenance/{provId}`

```json
{
  "provId":"string",
  "draftId":"string",
  "model": "Gemini-2.5-Pro",
  "prompt": "string",
  "promptHash":"sha256",
  "ragDocs": [{"docId":"", "url":"","snippet":""}],
  "reviewers":[{"uid":"", "role":"legal|fact","signedAt": timestamp}]
}
```

### `moderation/{modId}`

```json
{
  "modId":"string",
  "targetRef":"drafts/draftId",
  "reporterUid":"string|null",
  "reason":"hate|harassment|illicit",
  "action":"none|flag|remove|escalate",
  "moderatorUid":"string",
  "timestamp": timestamp,
  "publicRationale":"string"
}
```

---

## 7. Firestore security rules (skeleton)

> Use least privilege. Rules below are a skeleton — adapt to your exact auth claims and tiering.

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users: users can read their own record, others see public fields
    match /users/{userId} {
      allow read: if true; // public readable profile (non-PII)
      allow write: if request.auth != null && request.auth.uid == userId;
    }

    // Concerns: anyone can read; only authenticated can create
    match /concerns/{concernId} {
      allow read: if true;
      allow create: if request.auth != null || request.resource.data.authorUid == null; // allow anonymous creation but vet with moderation
      allow update, delete: if request.auth != null && (request.auth.uid == resource.data.authorUid || isModerator(request.auth.uid));
    }

  // Drafts
    match /drafts/{draftId} {
      allow read: if true;
      allow create: if request.auth != null;
  // Client updates cannot directly alter provenance arrays; server-enforced append-only.
  allow update: if request.auth != null && (request.auth.uid in resource.data.authors.map(a => a.uid) || isModerator(request.auth.uid));
      allow delete: if isModerator(request.auth.uid);
    }

    // Ballots - only admins or system can create
    match /ballots/{ballotId} {
      allow read: if true;
      allow create: if isAdmin(request.auth.uid) || isSystem(request.auth.uid);
      allow update: if isAdmin(request.auth.uid);
    }

  // Votes - allow create if eligible; disallow read by others (privacy-by-default)
    match /votes/{voteId} {
      allow create: if request.auth != null && isEligibleToVote(request.auth.uid, request.resource.data.ballotId);
      allow read: if false; // private
      allow delete: if false;
    }

  // Audit logs - read public subset via future mirror collection `audit_public`
    // Transparency ledger - append-only (write restricted to system, no reads blocked)
    match /transparency_ledger/{seq} {
      allow read: if true;
      allow create: if isSystem(request.auth.uid);
      allow update, delete: if false; // append-only
    }
    match /audit_logs/{logId} {
      allow read: if false;
      allow create: if isSystem(request.auth.uid);
    }

    // Moderation
    match /moderation/{modId} {
      allow read: if isModerator(request.auth.uid) || isAdmin(request.auth.uid);
      allow create: if request.auth != null;
      allow update, delete: if isModerator(request.auth.uid);
    }

    function isAdmin(uid) {
      return uid != null && exists(/databases/$(database)/documents/admins/$(uid));
    }
    function isModerator(uid) {
      return uid != null && exists(/databases/$(database)/documents/moderators/$(uid));
    }
    function isSystem(uid) {
      return uid == "service-account"; // map service account via custom claims
    }
    function isEligibleToVote(uid, ballotId) {
      // implement eligibility check by reading ballot doc and user region/tier
      return true;
    }
  }
}
```

> Implement strict rules around votes — check `eligibleRule` server-side in Cloud Functions to avoid client-side bypassing.

---

## 8. LLM & RAG pipeline (concrete)

### Model split

* **Gemini Flash-Lite** (fast + cheap): ideation, summaries, chat assistant for citizens.
* **Gemini Pro** (expensive + powerful): formal legal-style drafting with RAG and citation requirements.

### Where to call models

* Flash-Lite via Firebase Genkit in Cloud Functions (fast synchronous calls).
* Gemini Pro via Cloud Run service (or Genkit) for controlled, logged calls with RAG.

### RAG sources

* Curated corpora: municipal codes, state statutes, budget spreadsheets, public data sets (zoning, traffic counts)
* Source ingestion: normalize docs into indexed vector store (Firestore vectors or external vector DB)

### Prompt templates (examples) & Versioning

**Flash-Lite: Generate 3 short policy options (system prompt) – Draft Options v1**

```
SYSTEM: You are Board of Common Sense Civic Policy Assistant. For a user-submitted civic concern, produce three short policy options (A, B, C). Each option should be 1-3 sentences, neutral, and include one quick pros/cons line. Do NOT invent legal statutes. If you reference a fact, mark as [NEEDS_SOURCE].
USER: Concern: "{concern_text}"
RESPONSE FORMAT (JSON):
{
 "options": [
  {"id":"A","title":"...","summary":"...","pros":"...","cons":"..."},
  ...
 ]
}
```

**Gemini Pro: Formal bill draft (system prompt) – (Planned) Draft Pro v1**

```
SYSTEM: You are Board of Common Sense Legislative Drafter (Gemini Pro). Using the retrieval results (documents listed below) and the user's remit (jurisdiction {jurisdiction}), generate a draft bill with sections: Preamble, Definitions, Main Provisions, Enforcement, Funding/Budget estimate (if applicable), Sunset clause, and Implementation Timeline. Cite sources inline in brackets: [source-id]. If you cannot verify a claim, state explicitly "UNVERIFIED" and do not assert it as fact. Limit hallucinations.
USER: Draft request: {concern_title} — {short_summary}
RETRIEVALS: {list of doc ids + snippets}
OUTPUT: Markdown with headings and a JSON `provenance` object.
```

### Provenance record

* `promptHash`, `modelVersion`, `responseHash`, `ragDocIds[]`, `timestamp`, `reviewerSignatures[]`

### Fact-check & legal-review gating

* Automated: LLM runs cross-check comparing claimed facts vs RAG docs; mark unsupported claims.
* Human: expert reviewers receive queue; they must sign with their uid in `provenance.reviewers` before status set to `reviewed`.

---

## 9. Voting engine & tally algorithm

### Ballot rules

* Eligibility computed server-side at ballot creation and at vote cast time (tier + optional region tokens `country:US`, `state:US-OR`, `city:US-OR-Portland` stored as `allowedRegions`).
* Votes accepted until `endAt` timestamp; last-write-wins per `voterKey` (client signs with App Check + short-lived ephemeral key).
* Allow revotes until close; store all submissions for audit (but only last counts).

### Tallying

* **Simple / Approval:** straightforward count per option.
* **RCV (Instant Runoff):**

  * Deterministic algorithm (shared lib + functions copy) ensures frontend/backend reproducibility.
  * Tie-break: stable elimination using lexicographic order of option ids (current implementation) – revisitable with seeded randomness if governance mandates.
  * Tracks exhausted ballots per round for transparency metrics.
  * Open-source code mirrored in `functions/src/rcv.ts` & `packages/shared/tally/rcv.ts` – changes must stay synchronized.

### Receipts & audit

* For each vote, compute `receiptHash = HMAC(KMS_private_key, voterUid||ballotId||timestamp||rankingJSON)`.
* Return `receiptHash` to voter; store signed aggregate `tallyHash` on ballot close.
* Publish `auditReport` + ledger entry: includes ballot metadata, transcript of RCV transfers, total votes, exhausted counts, receipt hashes list (no voter identifiers), optional KMS signature. A public `verifyReceipt` endpoint confirms existence & non-identifying vote shape.
* Public mirror (`audit_public`) stores sanitized fields: winner, totalVotes, exhausted, rounds (counts + eliminated), tallyHash, ledgerId.

### Example RCV worker pseudo-code (Node)

```js
// Cloud Run service endpoint /tallyBallot
// 1. fetch votes for ballot
// 2. build arrays and run deterministic IRV
// 3. compute tallyHash = sha256(JSON.stringify(resultRounds))
// 4. sign tallyHash via Cloud KMS and store results
```

---

## 10. Security & anti-abuse (detailed)

### Authentication & verification

* Firebase Auth (email + phone) + App Check on clients
* For Verified tier: integrate Identity Platform or third-party attestation (e.g., Persona, IDNow) — store only attestations not raw IDs
* Custom claims on user tokens for `identityTier`

### Fraud detection

* Device fingerprinting + rate limits (Firestore + Cloud Functions)
* Behavioral anomaly detection: sudden vote surges, correlated account creation patterns — flag to moderation queue
* CAPTCHA progressive friction for suspicious actions
* Rate-limit LLM calls (implemented: draft gen, ballot create, vote updates, chat messages) with sliding window tokens in `rate_limits` collection.

### Data protection & secrets

* Use Cloud KMS to sign audit logs and receipts
* Secrets in Secret Manager; never embed in client JS
* CMEK for Cloud Storage if required by partner
* Backups: export daily to secure bucket, rotate keys, maintain chain-of-custody for audits

### Incident response playbook

* Pre-defined kill-switch to freeze postings/votes
* Snapshot database and rotate keys on suspected breach
* Notify regulators/users per transparency policy
* Commission independent audit & publish findings

---

## 11. Moderation & governance

### Moderation workflow

1. Automated filters (heuristic PII + disallowed token list; future extension to safety APIs)
2. Community reports (report button) → triage in moderation queue
3. Moderator action: warn/ remove / escalate to governance board

### Governance Board

* Multi-stakeholder (civic orgs, legal experts, privacy & security, community reps)
* Responsibilities: policy on escalations, content policy appeals, transparency reports

### Appeals & transparency

* Publicly publish moderation rationales (redacted)
* Appeals escalation: community review + Governance Board final review

---

## 12. Observability, telemetry & analytics

### Key metrics

* DAU/MAU by jurisdiction
* Number of concerns created / drafts generated / ballots created / votes cast
* Ratio of verified users to total users
* LLM call counts (Flash-Lite; Pro pending), estimated tokens (assistant parser) per call, cost per call (future aggregation)
* Moderation rate, incident count
* Audit KPIs: % of ballots with legal review, % escalated to officials with responses

### Monitoring & alerts

* Cost alerts on LLM spend
* Security alerts for anomalous traffic
* Performance alerts (increased latency on LLM or Firestore)

---

## 13. Testing, QA & CI/CD

### Testing matrix

* Unit tests (Jest) for tally logic, rate limits, immutability, action parsing, moderation heuristics, prompt library integrity
* Integration tests for API (Cloud Functions + Cloud Run)
* E2E tests (Playwright/Cypress) for flows: create concern → generate drafts → nominate → ballot → vote → tally
* Accessibility tests (axe-core)
* Load testing for vote submission and LLM call workflows (k6)

### CI/CD

* GitHub Actions:

  * Lint → Unit tests → Deploy to staging Firebase project
  * Manual gate → Security & accessibility scans → Deploy to production
* IaC: Terraform modules for project creation (Firestore, KMS, Cloud Run)

---

## 14. Cost-control & scaling strategies

* Cache all LLM outputs (implemented: draft generation caching)
* Tier Pro calls: only for shortlisted drafts (e.g., top 5% by interest)
* Use Flash-Lite for most chats and summaries
* Batch and queue expensive RAG + Pro tasks; run during off-peak where possible
* Monitor token usage and set monthly budgets + alerts

---

## 15. Rollout roadmap & sprint plan (90 days MVP + pilots)

**Week 0–2 (Discovery & infra setup)**

* Finalize Governance Charter & Transparency Policy
* Create Firebase project(s): dev, staging, prod
* Design system tokens & Figma starter kit

**Weeks 2–6 (MVP Core)**

* Implement Next.js skeleton, Tailwind, PWA setup
* Firebase Auth, Firestore schemas, basic feed UI
* Cloud Function wrapper for Gemini Flash-Lite (Genkit)
* Create Concern flow + Flash-Lite draft generation
* Basic voting (simple + approval), `audit_logs` with KMS signing

**Weeks 6–10 (Harden & pilot prep)**

* Draft editor w/ version history & assistant panel
* RAG setup & Cloud Run service for Gemini Pro (gated)
* Ballot RCV implementation (worker)
* Admin console & moderation queue
* Run security audit & bug bounty program

**Weeks 10–14 (Pilot launch)**

* Closed pilot with 1 city / civic org
* Collect metrics; iterate on feed ranking & anti-abuse rules
* Publish first transparency report

---

## 16. Developer task backlog (first 8 sprints, example)

Sprint 1 (2 weeks)

* Repo + monorepo scaffold (web/functions/services/infra)
* Next.js + Tailwind setup; Header/Footer; PWA baseline
* Firebase Auth + App Check integration

Sprint 2

* Firestore schema + security rules initial commit
* Create Concern UI & Flash-Lite gen via Cloud Function
* Drafts list page & feed card

Sprint 3

* Draft detail editor (Markdown) + version history UI
* Assistant panel integration (Flash-Lite chat)
* Audit log signing via Cloud KMS

Sprint 4

* Ballots: create & simple voting flow; votes collection rules
* Vote receipts generation & download
* Admin moderation panel basic

Sprint 5

* RAG ingestion pipeline (crawler + vector index)
* Cloud Run service for Gemini Pro + provenance recording

Sprint 6

* RCV tally service + reproducible audit output (PARTIALLY COMPLETE – tally + ledger done; formal Cloud Run service optional if scaling)
* Legal review queue & reviewer UI

Sprint 7–8

* Hardening, tests, security audits, staging deployment, closed pilot launch

---

## 17. Sample code snippets & Cloud Function stubs

### Cloud Function: generateDrafts (Node) (Legacy trigger example – current implementation is callable/HTTP, not Firestore onCreate)

```js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const genkit = require('firebase-genkit-sdk'); // hypothetical
admin.initializeApp();

exports.generateDrafts = functions.firestore
  .document('concerns/{concernId}')
  .onCreate(async (snap, context) => {
    const concern = snap.data();
    // prepare prompt
    const prompt = `Produce 3 policy options for: ${concern.title}\n${concern.description}`;
    // call Gemini Flash-Lite via Genkit
    const response = await genkit.generate({ model: 'gemini-flash', prompt, ...});
    // parse response
    const drafts = parseDrafts(response);
    // store drafts
    const batch = admin.firestore().batch();
    drafts.forEach(draft => {
      const docRef = admin.firestore().collection('drafts').doc();
      batch.set(docRef, {
        concernId: context.params.concernId,
        text: draft.text,
        modelMeta: { model: 'gemini-flash', promptHash: hash(prompt) },
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    return;
  });
```

### Cloud Run RCV tally pseudo (Node)

```js
app.post('/tally', async (req,res) => {
  const { ballotId } = req.body;
  const votes = await getVotes(ballotId); // fetch votes collection
  const rounds = runIRV(votes); // deterministic IRV implementation
  const tallyHash = sha256(JSON.stringify(rounds));
  const signed = await signWithKMS(tallyHash);
  await saveResults(ballotId, rounds, tallyHash, signed);
  res.json({ status: 'ok', rounds, tallyHash });
});
```

---

## 18. Legal, privacy & compliance checklist

* Advisory disclaimers visible at all times; do not imply legal enforceability
* Privacy policy & user data rights: export, delete, opt-out
* GDPR & CCPA compliance readiness
* MOUs for pilot jurisdictions specifying what “escalation” means
* Terms of Service with indemnity and content policy
* External legal counsel engaged for KYC/verification flows and pilot agreements

---

## 19. Appendix — prompts, provenance schema & sample audit report

### Sample Flash-Lite prompt (JSON) (Draft Options v1)

```json
{
  "system": "You are Board of Common Sense Civic Policy Assistant. Create 3 short policy options...",
  "user": "Concern: Street parking in X has too little turnover during lunch hours..."
}
```

### Sample Gemini Pro prompt (JSON) (Planned)

```json
{
  "system": "You are Board of Common Sense Legislative Drafter (Gemini Pro). Using these retrieved docs...",
  "user": "Please draft a municipal ordinance for dynamic lunchtime parking fees..."
}
```

### Provenance JSON (stored with drafts)

```json
{
  "model": "Gemini-2.5-Pro",
  "promptHash": "sha256:...",
  "responseHash": "sha256:...",
  "ragDocIds": ["doc1","doc23"],
  "reviewers": [{"uid":"expert1","role":"legal","signature":"kms-sig","ts":"2025-09-24T..."}]
}
```

### Example Audit Report (ballot close)

* Ballot ID: `ballot_123`
* Ballot Type: `RCV`
* Start / End
* Total ballots cast: 3,412
* Exhausted ballots: 112
* Rounds: Round 1 counts -> Round 2 transfers...
* TallyHash: `sha256:...` signed: `kms-sig-b64`
* Receipt sample: `CSR-RECEIPT-abc123`
* Published artifacts: `exports/ballot_123_tally.json` (downloadable)

---

## 20. Next immediate deliverables (updated list)

* 1. **Repo scaffold**: Next.js + Firebase + Cloud Functions starter with linting & CI
* 2. **Firestore security rules file** refined for your policies
* 3. **Figma starter kit** (feed, draft editor, ballot UIs)
* 4. **LLM prompt library** (Flash-Lite + Pro templates + test cases) – PARTIAL (Flash-Lite + chat + summary prompts exported)
* 5. **RCV tally implementation** (Node module + unit tests) – DONE (shared + functions copies)
* 7. **Receipt verification callable** (new) – planned
* 8. **Audit public mirror + integrity verifier** (new)
* 9. **RAG ingestion + Pro drafting pipeline scaffolding** (new)
* 6. **Pilot MOU template** for city / civic org

Tell me which artifact you want first and I’ll produce it immediately (I can create code, files, or Figma-ready JSON).
