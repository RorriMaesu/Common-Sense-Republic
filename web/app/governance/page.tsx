export default function GovernancePage() {
  return (
    <div className="prose dark:prose-invert max-w-3xl">
      <h1 className="text-3xl font-semibold mb-4">Platform Governance</h1>
      <p>Common Sense Republic governance evolves with community input. This interim page outlines the intended principles that guide feature rollout and moderation.</p>
      <h2>Principles</h2>
      <ol>
        <li>Transparency: Every critical action (draft generation, tally) has an auditable hash chain reference.</li>
        <li>Provenance Integrity: Draft and vote cryptographic hashes are immutable once published.</li>
        <li>Minimal Power Surface: Admin actions are logged; future on-chain or multi-sig options considered.</li>
      </ol>
      <h2>Planned Roadmap Highlights</h2>
      <ul>
        <li>Decentralized verification of tally results</li>
        <li>Expanded expert review tiers</li>
        <li>Community-driven moderation escalation flows</li>
      </ul>
      <p className="text-sm text-muted">This is a placeholder statement. A formal governance charter will replace this before broad public release.</p>
    </div>
  );
}
