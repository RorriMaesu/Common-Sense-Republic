"use client";
import { useFallbackFlag } from '../../lib/ui';

export default function FallbackBanner() {
  const { fallback } = useFallbackFlag();
  if (!fallback) { return null; }
  return (
    <div role="status" aria-live="polite" className="mb-4 text-[11px] rounded-md px-3 py-2 bg-amber-600/90 text-white shadow">
      AI operating in reduced mode. Results may be generic; retry later for full quality.
    </div>
  );
}
