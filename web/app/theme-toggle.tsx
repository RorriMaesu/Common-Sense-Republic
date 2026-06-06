"use client";
import { useEffect, useState } from 'react';

export default function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(()=> { setMounted(true); setDark(document.documentElement.classList.contains('dark')); },[]);
  function toggle() {
    const next = !dark; setDark(next);
    const root = document.documentElement;
    if (next) root.classList.add('dark'); else root.classList.remove('dark');
    try { localStorage.setItem('csr-theme', next? 'dark':'light'); } catch {}
  }
  if (!mounted) return <button aria-label="Toggle theme" className="btn-ghost" disabled>…</button>;
  return (
    <button onClick={toggle} aria-label="Toggle theme" className="btn-ghost flex items-center gap-1">
      {dark ? (
        <>
          <SunIcon className="w-4 h-4" /> <span className="hidden sm:inline">Light</span>
        </>
      ) : (
        <>
          <MoonIcon className="w-4 h-4" /> <span className="hidden sm:inline">Dark</span>
        </>
      )}
    </button>
  );
}

function SunIcon(props: any) { return (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2m16 0h2M6.34 17.66l1.41-1.41M15.66 8.75l1.41-1.41" />
  </svg>
); }
function MoonIcon(props: any) { return (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 12.79A9 9 0 0 1 11.21 3 7 7 0 0 0 12 17a7 7 0 0 0 9-4.21Z" />
  </svg>
); }
