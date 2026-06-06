import Link from 'next/link';

export const metadata = {
  title: 'Contribute — Common Sense Republic',
  description: 'Help build an auditable, trustworthy civic drafting and voting platform.'
};

export default function ContributePage() {
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Contribute & Support</h1>
        <p className="text-sm text-muted max-w-2xl leading-relaxed">Common Sense Republic is in active, transparent development. You can accelerate verifiable civic collaboration by contributing code, reviewing security, improving accessibility, or helping cover infrastructure and model costs.</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/transparency" className="btn-secondary text-xs">Transparency</Link>
          <a href="https://buymeacoffee.com/rorrimaesu" target="_blank" rel="noopener noreferrer" className="btn-primary text-xs">Donate Coffee</a>
        </div>
      </section>
      <section className="grid md:grid-cols-2 gap-6">
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold text-sm">Engineering</h2>
          <p className="text-[13px] leading-relaxed text-muted">Help refine tally algorithms, strengthen Firestore security rules, reduce latency, or design deterministic verification tooling.</p>
          <ul className="list-disc ml-5 text-[12px] space-y-1 text-muted">
            <li>Delegated vote weighting model (spec first)</li>
            <li>Offline ballot verification bundle viewer</li>
            <li>CI pipeline (lint, test, minimal deploy preview)</li>
          </ul>
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold text-sm">Trust & Safety</h2>
          <p className="text-[13px] leading-relaxed text-muted">Advance moderation heuristics, model output auditing, and anomaly detection without sacrificing openness.</p>
          <ul className="list-disc ml-5 text-[12px] space-y-1 text-muted">
            <li>Incremental abuse pattern scoring</li>
            <li>Explainable moderation rationale logs</li>
            <li>Rate‑limit telemetry visualization</li>
          </ul>
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold text-sm">UX & Accessibility</h2>
            <p className="text-[13px] leading-relaxed text-muted">Polish mobile flows, improve keyboard semantics, and reduce friction in drafting & voting journeys.</p>
            <ul className="list-disc ml-5 text-[12px] space-y-1 text-muted">
              <li>Ballot result diff / replay UI</li>
              <li>High contrast & reduced motion audit</li>
              <li>Screen reader verification flow</li>
            </ul>
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold text-sm">Documentation</h2>
            <p className="text-[13px] leading-relaxed text-muted">Clarify ledger integrity, receipt verification steps, and lawful open governance guidelines.</p>
            <ul className="list-disc ml-5 text-[12px] space-y-1 text-muted">
              <li>Receipt verification illustrated guide</li>
              <li>Ledger chain threat model & FAQ</li>
              <li>Public governance charter draft</li>
            </ul>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold text-sm">Getting Started</h2>
        <ol className="list-decimal ml-5 text-[12.5px] leading-relaxed text-muted space-y-1">
          <li>Read <code>CONTRIBUTING.md</code> at the repo root.</li>
          <li>Pick one scoped improvement (open an issue or reference an existing one).</li>
          <li>Create a short design note if touching tally, receipt, or ledger logic.</li>
          <li>Open a draft PR early—favor iteration over big bang delivery.</li>
        </ol>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold text-sm">Support Without Coding</h2>
        <p className="text-[13px] text-muted max-w-xl">Share Common Sense Republic with civic technologists, policy researchers, or local community groups; or sponsor infra/model usage with a coffee.</p>
        <a href="https://buymeacoffee.com/rorrimaesu" target="_blank" rel="noopener noreferrer" className="btn-primary text-xs w-fit">Donate</a>
      </section>
    </div>
  );
}