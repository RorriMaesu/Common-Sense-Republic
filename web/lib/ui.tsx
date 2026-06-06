"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface Toast { id: string; message: string; tone: 'info'|'error'|'success'|'warn'; ttl?: number; }
const ToastCtx = createContext<{ push: (t: Omit<Toast,'id'>)=>void }|null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(()=> {
    const iv = setInterval(()=> {
      setToasts(ts => ts.filter(t => !t.ttl || Date.now() < parseInt(t.id.split(':')[0])));
    }, 1500);
    return ()=> clearInterval(iv);
  }, []);
  const push = useCallback((t: Omit<Toast,'id'>) => {
    const expires = t.ttl ? Date.now() + t.ttl : Date.now() + 8000;
    setToasts(ts => [...ts, { ...t, id: `${expires}:${Math.random().toString(36).slice(2)}` }]);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed z-50 bottom-3 right-3 flex flex-col gap-2 max-w-xs">
        {toasts.map(t => (
          <div key={t.id} className={`text-[11px] rounded-md px-3 py-2 shadow-md backdrop-blur border animate-fadeIn ${toneCls(t.tone)}`}>{t.message}</div>
        ))}
      </div>
      <style jsx global>{`
        .animate-fadeIn { animation: fadeIn .35s ease; }
        @keyframes fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform: translateY(0); } }
      `}</style>
    </ToastCtx.Provider>
  );
}

function toneCls(t: Toast['tone']) {
  switch(t) {
    case 'error': return 'bg-red-600/90 text-white border-red-500/50';
    case 'success': return 'bg-emerald-600/90 text-white border-emerald-400/40';
    case 'warn': return 'bg-amber-600/90 text-white border-amber-400/40';
    default: return 'bg-black/70 text-white border-white/10';
  }
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) { throw new Error('ToastProvider missing'); }
  return ctx.push;
}

// Fallback (LLM degraded) context
const FallbackCtx = createContext<{ fallback: boolean; setFallback: (b:boolean)=>void }|null>(null);
export function FallbackProvider({ children }: { children: React.ReactNode }) {
  const [fallback, setFallback] = useState(false);
  return <FallbackCtx.Provider value={{ fallback, setFallback }}>{children}</FallbackCtx.Provider>;
}
export function useFallbackFlag() {
  const c = useContext(FallbackCtx);
  if (!c) { throw new Error('FallbackProvider missing'); }
  return c;
}
