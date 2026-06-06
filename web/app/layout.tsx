import './globals.css';
import type { Metadata } from 'next';
import { ReactNode, useEffect, useState } from 'react';
import Header from './header';
import { ToastProvider, FallbackProvider } from '../lib/ui';
import Link from 'next/link';
import Image from 'next/image';
import SupportRibbon from './SupportRibbonClient'; // renamed to avoid circular export issues

export const metadata: Metadata = {
  title: 'Common Sense Republic — Draft. Debate. Decide.',
  description: 'Common Sense Republic — a trustworthy, auditable public square for drafting and voting on policy proposals.',
  icons: {
    icon: '/logo.png',
    shortcut: '/favicon.ico',
    apple: '/logo.png',
  },
  openGraph: {
    title: 'Common Sense Republic',
    description: 'Direct Digital Democracy. Own the agenda.',
    url: 'https://wevote-v1.web.app', // Update if domain changes
    siteName: 'Common Sense Republic',
    images: [
      {
        url: '/logo.png',
        width: 512,
        height: 512,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#1B2A4E" />
        {/* Progressive Web App capability meta tags. "apple-mobile-web-app-capable" is considered legacy in some tooling; */}
        {/* we retain it for iOS Safari while adding the standardized mobile-web-app-capable for broader hinting. */}
        <meta name="mobile-web-app-capable" content="yes" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script
          // Set initial theme before paint to avoid flash
          dangerouslySetInnerHTML={{ __html: `(() => {try {const ls = localStorage.getItem('csr-theme'); const mql = window.matchMedia('(prefers-color-scheme: dark)'); const dark = ls ? ls==='dark' : mql.matches; if (dark) document.documentElement.classList.add('dark');} catch(_) {}})();` }} />
      </head>
      <body className="theme-transition">
        <ToastProvider>
          <FallbackProvider>
            <div className="min-h-screen flex flex-col">
              <Header />
              <main id="main" className="flex-1 container mx-auto px-4 py-6" role="main">
                {children}
                <SupportRibbon />
              </main>
              <Footer />
            </div>
          </FallbackProvider>
        </ToastProvider>
      </body>
    </html>
  );
}

// Header moved to dedicated client component for responsive / interactive nav

function Footer() {
  return (
    <footer className="border-t mt-12 text-xs py-6 bg-[var(--bg)]/70" role="contentinfo">
      <div className="container mx-auto px-4 flex flex-wrap gap-4 items-center text-muted">
        <p className="whitespace-nowrap">&copy; {new Date().getFullYear()} Common Sense Republic.</p>
        <nav aria-label="Secondary" className="flex flex-wrap gap-4 items-center">
          <a href="/transparency" className="hover:text-[var(--text)] transition-colors">Transparency</a>
          <a href="/governance" className="hover:text-[var(--text)] transition-colors">Governance</a>
          <a href="/privacy" className="hover:text-[var(--text)] transition-colors">Privacy</a>
        </nav>
      </div>
    </footer>
  );
}

// SupportRibbon moved to client component ./support-ribbon.tsx for dismiss + persistence
