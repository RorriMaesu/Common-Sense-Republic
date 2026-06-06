"use client";
import { useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '../lib/firebaseClient';
import { createPortal } from 'react-dom';
import ThemeToggle from './theme-toggle';
import { LocalLlmRouter, MODEL_TIERS, OLLAMA_BASE_URL } from '../lib/localLlmRouter';

import Image from 'next/image';
import Link from 'next/link';

const NAV_LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/feed', label: 'Concern Pool' },
  { href: '/concern/new', label: 'Create Concern' },
  { href: '/forums', label: 'Forums' },
  { href: '/admin/drafting', label: 'Drafting' },
  { href: '/transparency', label: 'Transparency' },
  { href: '/verify', label: 'Verify' }
];

function useFocusTrap(active: boolean, containerRef: React.RefObject<HTMLDivElement>, onExit: () => void) {
  useEffect(() => {
    if (!active) return;
    const node = containerRef.current;
    const selectors = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getItems = () => Array.from(node?.querySelectorAll<HTMLElement>(selectors) || []);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onExit(); }
      if (e.key === 'Tab') {
        const items = getItems(); if (!items.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    setTimeout(()=> { const first = getItems()[0]; first?.focus(); }, 0);
    return () => document.removeEventListener('keydown', handleKey);
  }, [active, containerRef, onExit]);
}

function useAuthUser() {
  const [user, setUser] = useState<any>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);
  return user;
}

export default function Header() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(open, panelRef, () => setOpen(false));

  const user = useAuthUser();
  const firstName = user?.displayName ? String(user.displayName).split(' ')[0] : null;
  const handleSignOut = async () => { try { await signOut(auth); } catch {} };

  // AI Router Settings States
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiRoute, setAiRoute] = useState<'ollama' | 'webgpu'>('ollama');
  const [ollamaModel, setOllamaModel] = useState('gemma4:e4b');
  const [webGpuModel, setWebGpuModel] = useState('gemma-4-e2b');
  const [ollamaOk, setOllamaOk] = useState(false);
  const [hardware, setHardware] = useState({ ramGb: 8, webGpuAvailable: false });
  
  // Progress tracking
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStatus, setProgressStatus] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      let mode = LocalLlmRouter.getRouteMode() as any;
      if (mode === 'cloud') {
        mode = 'ollama';
        LocalLlmRouter.setRouteMode('ollama');
      }
      setAiRoute(mode);
      setOllamaModel(LocalLlmRouter.getOllamaModel());
      setWebGpuModel(LocalLlmRouter.getWebGpuModel());
      LocalLlmRouter.getHardwareInfo().then(setHardware);
      LocalLlmRouter.checkOllamaStatus().then(setOllamaOk);
    }
  }, [showAiModal]);

  const handleRouteToggle = (mode: 'ollama' | 'webgpu') => {
    setAiRoute(mode);
    LocalLlmRouter.setRouteMode(mode);
  };

  const handleOllamaModelSelect = (model: string) => {
    setOllamaModel(model);
    LocalLlmRouter.setOllamaModel(model);
  };

  const handleWebGpuModelSelect = (model: string) => {
    setWebGpuModel(model);
    LocalLlmRouter.setWebGpuModel(model);
  };

  const startOllamaPull = async () => {
    setIsDownloading(true);
    setProgressPercent(0);
    setProgressStatus('Checking Ollama connection status...');
    try {
      let online = await LocalLlmRouter.checkOllamaStatus();
      if (!online) {
        setProgressStatus('Ollama is offline. Triggering sidecar helper & custom protocol launch...');
        await LocalLlmRouter.triggerOllamaLaunch();
        
        let connected = false;
        const maxAttempts = 15;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          setProgressStatus(`Polling background instance... (Attempt ${attempt}/${maxAttempts})`);
          await new Promise(r => setTimeout(r, 1500));
          online = await LocalLlmRouter.checkOllamaStatus();
          if (online) {
            connected = true;
            break;
          }
        }
        
        if (!connected) {
          throw new Error('Connection timeout. Please open the Ollama app manually, or run "ollama serve" in your system terminal.');
        }
      }
      
      setOllamaOk(true);
      setProgressStatus('Checking model installation status...');
      const installed = await LocalLlmRouter.checkOllamaModelInstalled(ollamaModel);
      if (installed) {
        setProgressStatus(`Model "${ollamaModel}" is already installed. Preloading into VRAM...`);
        await LocalLlmRouter.preloadOllamaModel(ollamaModel);
        setProgressStatus(`✓ Model "${ollamaModel}" is active and ready!`);
        setTimeout(() => {
          setIsDownloading(false);
          setShowAiModal(false);
        }, 1500);
        return;
      }
      
      setProgressStatus(`Initiating download for "${ollamaModel}"...`);
      await LocalLlmRouter.pullOllamaModel(ollamaModel, (percent, status) => {
        setProgressPercent(percent);
        setProgressStatus(status || `Downloading: ${percent}%`);
      });
      
      setProgressStatus('Preloading newly downloaded model into VRAM...');
      await LocalLlmRouter.preloadOllamaModel(ollamaModel);
      setProgressStatus(`✓ Successfully pulled and activated ${ollamaModel}!`);
      setTimeout(() => {
        setIsDownloading(false);
        setShowAiModal(false);
      }, 1500);
    } catch (err: any) {
      setProgressStatus(`Error: ${err.message || 'Failed'}`);
      setTimeout(() => setIsDownloading(false), 8000);
    }
  };

  const startWebGpuDownload = async () => {
    setIsDownloading(true);
    setProgressPercent(0);
    setProgressStatus('Downloading WebGPU model to local storage...');
    try {
      await LocalLlmRouter.loadWebGpuEngine((stage, percent) => {
        setProgressPercent(percent);
        setProgressStatus(stage);
      });
      setProgressStatus('✓ WebGPU Model loaded and cached in OPFS!');
      setTimeout(() => {
        setIsDownloading(false);
        setShowAiModal(false);
      }, 1500);
    } catch (err: any) {
      setProgressStatus(`Error: ${err.message}`);
      setTimeout(() => setIsDownloading(false), 4000);
    }
  };

  const purgeWebGpuCache = async () => {
    if (confirm('Are you sure you want to clear your browser LLM model cache? This will delete gigabytes of model files from OPFS.')) {
      await LocalLlmRouter.purgeWebGpuStorage();
      alert('Local storage cleared successfully.');
    }
  };

  // Prevent body scroll
  useEffect(()=> {
    if (!open) return;
    const prev = document.body.style.overflow; document.body.style.overflow='hidden';
    const triggerEl = triggerRef.current;
    return () => { document.body.style.overflow = prev; triggerEl?.focus(); };
  }, [open]);

  const portal = (open && typeof document !== 'undefined') ? createPortal(
    <div className="fixed inset-0 z-[999]" role="dialog" aria-modal="true" aria-labelledby="mobile-menu-heading" data-menu-root>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={()=> setOpen(false)} aria-hidden="true" />
      <div
        ref={panelRef}
        id="mobile-nav-panel"
        tabIndex={-1}
        className="fixed top-0 right-0 h-full w-72 max-w-[82%] flex flex-col p-5 gap-4 shadow-xl overflow-y-auto text-[var(--text)] bg-[var(--panel-bg)] border-l border-[var(--border)]"
      >
        <div className="flex items-center justify-between pr-1">
          <h2 id="mobile-menu-heading" className="font-semibold tracking-tight text-sm">Menu</h2>
          <button onClick={()=> setOpen(false)} aria-label="Close menu" className="btn-ghost px-2 py-1 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-teal/40">
            <svg width="18" height="18" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M4 4l10 10M14 4L4 14" /></svg>
          </button>
        </div>
        <nav className="flex flex-col gap-1 text-sm" aria-label="Mobile navigation">
          {NAV_LINKS.map(item => (
            <a key={item.href} onClick={()=> setOpen(false)} href={item.href} className="rounded px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-brand-teal/40 transition-colors text-[var(--text)] hover:bg-[var(--hover)]">
              {item.label}
            </a>
          ))}
          <div className="pt-3 mt-3 border-t border-[var(--border)]/60 flex flex-col gap-2">
            {!user && (
              <a onClick={()=> setOpen(false)} href="/auth" className="btn-secondary text-center text-[13px] py-2">Sign In</a>
            )}
            {user && (
              <button onClick={()=> { handleSignOut(); setOpen(false); }} className="btn-secondary text-center text-[13px] py-2">Sign Out</button>
            )}
            <a onClick={()=> setOpen(false)} href="/concern/new" className="btn-primary text-center text-[13px] py-2">{user ? 'New Concern' : 'Create Concern'}</a>
          </div>
        </nav>
        <p className="mt-auto text-[10px] text-muted/80 pt-4">&copy; {new Date().getFullYear()} Common Sense Republic</p>
      </div>
    </div>, document.body) : null;

  return (
    <header className="sticky top-0 z-40 backdrop-blur border-b bg-[var(--bg)]">
      <div className="max-w-7xl mx-auto flex items-center gap-4 py-3 px-4">
        <a href="#main" className="sr-only focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-brand-teal/40 px-2 py-1 rounded bg-white/70 dark:bg-black/40 text-xs">Skip to content</a>
        <Link href="/" className="flex items-center gap-2">
          <div className="relative w-10 h-10 shrink-0">
             <Image src="/CommonSenseRepublicBasicLogoTransparentbg.png" alt="Logo" fill className="object-contain" /> 
          </div>
          <span className="font-bold text-lg tracking-tight leading-none" style={{color:'var(--text)'}}>
            <span className="text-[var(--brand-navy)] dark:text-white">Common Sense</span> <span className="text-[var(--brand-gold)]">Republic</span>
          </span>
        </Link>
        <nav className="hidden md:flex gap-5 text-sm text-muted" aria-label="Main navigation">
          {NAV_LINKS.map(l => <a key={l.href} className="hover:text-[var(--text)] transition-colors" href={l.href}>{l.label}</a>)}
        </nav>

        {/* AI Route Badge */}
        <div className="ml-auto hidden md:flex items-center gap-3">
          <button 
            onClick={() => setShowAiModal(true)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-extrabold tracking-wider uppercase border transition-all ${
              aiRoute === 'ollama' 
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20'
                : 'bg-purple-500/10 text-purple-500 border-purple-500/20 hover:bg-purple-500/20'
            }`}
          >
            <span>●</span>
            <span>{aiRoute === 'ollama' ? 'Ollama' : 'WebGPU'}</span>
          </button>

          <ThemeToggle />
          {!user && <a href="/auth" className="btn-ghost">Sign In</a>}
          {user && (
            <>
              <span className="text-xs text-muted max-w-[120px] truncate" title={user.displayName || user.email}>{firstName || 'Account'}</span>
              <button onClick={handleSignOut} className="btn-ghost text-xs">Sign Out</button>
            </>
          )}
          <a href="/concern/new" className="btn-primary">{user ? 'New Concern' : 'Create Concern'}</a>
        </div>

        <div className="ml-auto flex md:hidden items-center gap-2">
          <button 
            onClick={() => setShowAiModal(true)}
            className={`flex items-center px-2 py-1 rounded-full text-[9px] font-bold border transition-all ${
              aiRoute === 'ollama'
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                : 'bg-purple-500/10 text-purple-500 border-purple-500/20'
            }`}
          >
            AI Status
          </button>
          <ThemeToggle />
          <button ref={triggerRef} aria-label="Open menu" aria-expanded={open} aria-controls="mobile-nav-panel" onClick={()=> setOpen(o=>!o)} className="btn-ghost px-2 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-teal/40">
            <span className="sr-only">Menu</span>
            <svg width="20" height="20" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M3 6h14M3 12h14M3 18h14" /></svg>
          </button>
        </div>
      </div>
      {portal}

      {/* Local AI Settings Modal */}
      {showAiModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="ai-modal-heading">
          <div 
            className="absolute inset-0 backdrop-blur-sm" 
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.55)' }}
            onClick={() => setShowAiModal(false)} 
            aria-hidden="true"
          />
          <div 
            className="border rounded-3xl p-6 max-w-lg w-full relative z-10 shadow-2xl max-h-[90vh] overflow-y-auto"
            style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text)', borderColor: 'var(--border)' }}
          >
            <button 
              onClick={() => setShowAiModal(false)}
              className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-bold text-lg"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold mb-1">Local AI & Model Configuration</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>Choose how you want to route AI tasks for concern chat and bill proposals.</p>
            
            {/* Route Selection Toggles */}
            <div 
              className="grid grid-cols-2 gap-2 mb-4 p-1.5 rounded-xl border"
              style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              {(['ollama', 'webgpu'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => handleRouteToggle(mode)}
                  className={`py-2 px-3 text-xs font-bold rounded-lg transition-all capitalize ${
                    aiRoute === mode 
                      ? 'shadow' 
                      : 'opacity-75 hover:opacity-100'
                  }`}
                  style={aiRoute === mode ? {
                    backgroundColor: 'var(--card-bg)',
                    color: 'var(--text)',
                  } : {
                    color: 'var(--muted)',
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>

            {/* Hardware Status */}
            <div 
              className="mb-4 border p-3 rounded-xl flex justify-between items-center text-xs"
              style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              <span><strong>System RAM:</strong> ~{Math.round(hardware.ramGb)} GB</span>
              <span><strong>WebGPU:</strong> {hardware.webGpuAvailable ? '✅ Supported' : '❌ Unsupported'}</span>
              <span><strong>Ollama:</strong> {ollamaOk ? '✅ Online' : '❌ Offline'}</span>
            </div>

            {/* Sub-panels based on route */}

            {aiRoute === 'ollama' && (
              <div className="space-y-3">
                <div 
                  className="text-xs border p-4 rounded-xl"
                  style={{ backgroundColor: 'rgba(16, 185, 129, 0.05)', borderColor: 'rgba(16, 185, 129, 0.2)' }}
                >
                  <h4 className="font-bold mb-1" style={{ color: 'var(--accent-teal)' }}>Local PC AI (Ollama)</h4>
                  <p style={{ color: 'var(--muted)' }}>Execute LLMs completely locally on your machine. Ideal if you have a gaming GPU (NVIDIA/AMD) or Apple Silicon.</p>
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">Select Model Profile:</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['llama3.2', 'llama3', 'qwen2.5', 'gemma4:e4b'].map(model => (
                      <button
                        key={model}
                        onClick={() => handleOllamaModelSelect(model)}
                        className={`p-2.5 text-[11px] font-bold rounded-lg border text-left transition-all`}
                        style={ollamaModel === model ? {
                          borderColor: 'var(--accent-teal)',
                          backgroundColor: 'rgba(20, 184, 166, 0.08)',
                          color: 'var(--accent-teal)',
                        } : {
                          borderColor: 'var(--border)',
                          backgroundColor: 'var(--card-bg)',
                          color: 'var(--text)',
                        }}
                      >
                        {model === 'gemma4:e4b' ? 'Gemma 4 Pro (4.5B)' : model}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <button 
                    onClick={startOllamaPull}
                    disabled={isDownloading}
                    className="btn-primary w-full py-2.5 px-4 text-xs font-bold"
                  >
                    Pull / Download Selected Model
                  </button>
                </div>
              </div>
            )}

            {aiRoute === 'webgpu' && (
              <div className="space-y-3">
                <div 
                  className="text-xs border p-4 rounded-xl"
                  style={{ backgroundColor: 'rgba(139, 92, 246, 0.05)', borderColor: 'rgba(139, 92, 246, 0.2)' }}
                >
                  <h4 className="font-bold mb-1" style={{ color: 'var(--accent-teal)' }}>Browser WebGPU AI</h4>
                  <p style={{ color: 'var(--muted)' }}>Run models directly inside your browser tab without launching external apps. Uses WebGPU shaders.</p>
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">Select Browser Profile:</label>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.keys(MODEL_TIERS).map(id => (
                      <button
                        key={id}
                        onClick={() => handleWebGpuModelSelect(id)}
                        className={`p-2 text-[10px] font-bold rounded-lg border text-left transition-all`}
                        style={webGpuModel === id ? {
                          borderColor: 'rgba(139, 92, 246, 0.8)',
                          backgroundColor: 'rgba(139, 92, 246, 0.08)',
                          color: 'rgb(139, 92, 246)',
                        } : {
                          borderColor: 'var(--border)',
                          backgroundColor: 'var(--card-bg)',
                          color: 'var(--text)',
                        }}
                      >
                        {MODEL_TIERS[id].shortName}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <button 
                    onClick={startWebGpuDownload}
                    disabled={isDownloading}
                    className="btn-primary flex-1 py-2.5 px-4 text-xs font-bold"
                  >
                    Download & Pre-load
                  </button>
                  <button 
                    onClick={purgeWebGpuCache}
                    className="border border-red-500 text-red-500 hover:bg-red-500/5 text-xs font-bold px-3 rounded-xl"
                  >
                    Purge Storage
                  </button>
                </div>
              </div>
            )}

            {/* Integrated Downloading Progress Bar */}
            {isDownloading && (
              <div 
                className="mt-5 p-4 border rounded-2xl"
                style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)' }}
              >
                <p className="text-[11px] font-bold mb-1 truncate">{progressStatus}</p>
                <div 
                  className="w-full h-2.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: 'var(--border)' }}
                >
                  <div 
                    className="bg-red-600 h-2.5 transition-all duration-300" 
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex justify-between items-center mt-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                  <span>Progress: {progressPercent}%</span>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </header>
  );
}
