export default function PrivacyPage() {
  return (
    <div className="prose dark:prose-invert max-w-3xl">
      <h1 className="text-3xl font-semibold mb-4">Privacy Policy</h1>
      <p>Common Sense Republic is an experimental civic deliberation platform. We minimize data collection and store only what is required for:
        verification of draft/vote provenance, rate limiting for abuse prevention, and basic account functionality.</p>
      <h2>Data We Store</h2>
      <ul>
        <li>Authentication identifiers (Firebase Auth)</li>
        <li>Drafts, ballots, votes (with cryptographic hashes for transparency)</li>
        <li>Moderation reports and audit ledger entries (append-only)</li>
      </ul>
      <h2>Your Controls</h2>
      <ul>
        <li>You may delete your account via Firebase Auth; residual ledger entries remain for integrity.</li>
        <li>Receipts allow independent verification without revealing identity.</li>
      </ul>
      <p className="text-sm text-muted">This document is a placeholder. Not legal advice. Replace with a formal policy before production launch.</p>
    </div>
  );
}
