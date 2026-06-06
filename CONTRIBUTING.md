# Contributing to Common Sense Republic

First off, thank you for your interest in strengthening trustworthy, auditable civic collaboration.

Repository: https://github.com/RorriMaesu/Common-Sense-Republic

Clone / Fork from the GitHub URL above. Do **not** copy private deployment artifacts (e.g. real `.env`, service account JSON) into PRs. Use `.env.example` placeholders when documenting configuration.

## Core Principles
We optimize for:
1. Verifiability over gloss (hashes, receipts, provenance > visual flash)
2. Append-only trust surfaces (no retroactive mutation of historical data)
3. Deterministic logic (tallies, receipts, ledger entries must reproduce byte‑for‑byte)
4. Responsible AI integration (model output is post‑processed, validated, rate‑limited)

## Ways to Contribute
- Engineering: Firestore rules hardening, new tally methods (careful: must mirror shared + backend copies)
- Security & Abuse: Better moderation heuristics, anomaly detection for vote patterns
- UX / Accessibility: Mobile refinements, focus management, WCAG checks
- Transparency: Metrics dashboards, verification tooling, educational docs

## Development Quickstart
1. Install dependencies at root workspaces (`functions/`, `web/`, `packages/shared/`).
2. Build shared package: `npm run build --workspace=packages/shared`.
3. Emulator: `npm --workspace=functions run build && firebase emulators:start --only functions,firestore`.
4. Frontend dev: `npm --workspace=web run dev`.
5. Copy `web/.env.example` to `web/.env.local` and fill with your Firebase test project values.

Sensitive / Never Commit:
- Real API keys beyond public Firebase web config (Gemini, receipt HMAC secret, KMS key paths)
- Production Firestore export data
- Private signing keys (only the public verification key belongs in `web/public/`)

## Coding Standards
- Keep pure logic testable and side‑effect free.
- If you change tally or canonical hashing logic: update BOTH `functions/src/rcv.ts` and `packages/shared/tally/rcv.ts`.
- Never mutate existing ledger, audit, or provenance docs.
- Add unit tests for new helpers (Jest in `functions/test`).
- Avoid adding unpinned heavy dependencies; prefer native crypto/util libraries.

## Pull Requests
Include:
- Rationale (what trust or usability gap you’re closing)
- Data shape changes (explicit Firestore collection + fields) if any
- Test coverage for new logic

## Security / Disclosure
If you discover a vulnerability (logic bypass, ledger tampering vector, receipt forging), **do not open a public issue first**. Reach out via the project owner’s contact channel (temp: BuyMeACoffee message or forthcoming security alias). Responsible disclosure appreciated.

## Style Notes
- TypeScript strict patterns where feasible in new code.
- Prefer functional, composable helpers over large, stateful classes.
- Keep public UI copy concise; emphasize verifiability and user agency.

## Roadmap Seeds (Low Hanging Fruit)
- Dismissible announcements (now partially implemented for support ribbon)
- Offline verification bundle viewer (client‑only)
- Delegated vote weighting (requires cryptographic receipt design v2)
- Basic metrics panel (counts + rolling tallies) without exposing raw votes

Thanks for contributing with integrity. ✨
