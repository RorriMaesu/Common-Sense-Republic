"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

// Local storage key
const KEY = 'csr-hide-support-ribbon-v2';

export default function SupportRibbon(){
  const [hidden,setHidden] = useState(true);
  const [dismissed,setDismissed] = useState(false);

  useEffect(()=> {
    try { const v = localStorage.getItem(KEY); if (!v) setHidden(false); } catch { setHidden(false); }
  },[]);

  function dismiss(){
    setDismissed(true);
    try { localStorage.setItem(KEY,'1'); } catch {}
    setTimeout(()=> setHidden(true), 300); // match animation duration
  }

  if (hidden) return null;
  return (
    <aside className={`mt-16 mb-6 transition-opacity duration-300 ${dismissed? 'opacity-0 translate-y-2':'opacity-100'}`} aria-labelledby="support-heading">
      <div className="relative overflow-hidden rounded-xl border fade-border bg-[var(--card-bg)]/90 backdrop-blur p-5 flex flex-col sm:flex-row gap-5 items-start sm:items-center shadow-card">
        <div className="absolute inset-0 pointer-events-none opacity-0 sm:opacity-100 bg-[radial-gradient(circle_at_85%_20%,rgba(217,45,32,0.08),transparent_60%)]" />
        <div className="flex-1 relative space-y-1 pr-8">
          <h2 id="support-heading" className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-navy text-white text-[11px] shadow">β</span>
            Under Ongoing Development
          </h2>
          <p className="text-[12px] leading-relaxed text-muted max-w-xl">
            Built openly by a founder and early volunteers. If our mission of auditable, trustworthy civic drafting resonates, you can help: contribute code, share feedback, or fuel server & model costs with a small coffee.
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Link href="/contribute" className="btn-secondary text-[11px] py-1 px-3">Contribute</Link>
            <Link href="/transparency" className="btn-secondary text-[11px] py-1 px-3">Transparency</Link>
            <a href="https://buymeacoffee.com/rorrimaesu" target="_blank" rel="noopener noreferrer" className="group relative inline-flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/40">
              <span className="sr-only">Support development (opens external Buy Me a Coffee page)</span>
              <Image src="/support-coffee.svg" alt="Support development" width={180} height={52} className="h-12 w-auto transition-transform group-hover:scale-[1.02] group-active:scale-[0.98]" />
            </a>
          </div>
        </div>
        <div className="relative flex-1 sm:max-w-[220px] text-[11px] text-muted space-y-1">
          <p className="leading-relaxed">We prioritize transparency over polish—expect rapid iterations.</p>
          <p className="leading-relaxed">Every contribution shortens the path to verifiable public decision-making.</p>
        </div>
        <button onClick={dismiss} aria-label="Dismiss support message" className="absolute top-2 right-2 text-muted hover:text-[var(--text)] transition-colors p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/40">
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
    </aside>
  );
}
