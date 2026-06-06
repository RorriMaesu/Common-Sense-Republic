import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  const features = [
    { title: 'Own The Agenda', desc: 'You decide what matters, not lobbyists or media. Initiate concerns that become law.'},
    { title: 'Get Neutral Laws', desc: 'AI drafts honest options—no pork, no riders. Pure policy focus.'},
    { title: 'Take Control', desc: 'Vote directly. You are the Senator now. Verify every tally personally.'}
  ];
  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="text-center pt-8 pb-8 sm:pt-12 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-navy/5 via-transparent to-transparent">
        {/* Large Logo Card: Redundant text removed, logo size increased to act as main visual anchor */}
        <div className="relative w-64 h-64 sm:w-96 sm:h-96 mx-auto mb-8 p-6 bg-white rounded-[2.5rem] shadow-2xl shadow-brand-navy/10 border border-white/60 flex items-center justify-center transform hover:scale-105 transition-transform duration-700 ease-out">
           <div className="relative w-full h-full drop-shadow-sm">
             <Image src="/logo.png" alt="Common Sense Republic Shield" fill className="object-contain" priority sizes="(max-width: 768px) 256px, 384px" />
           </div>
        </div>
        
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-navy/5 text-brand-navy dark:bg-white/10 dark:text-white text-[10px] font-bold tracking-wider mb-6 uppercase">
          Direct Digital Democracy
        </div>

        <p className="text-muted max-w-2xl mx-auto mb-8 text-base sm:text-lg leading-relaxed px-4 font-medium">
          The filtered, auditable public square where you shape the agenda. Bypass the noise and draft bills that actually serve the republic.
        </p>
        <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 max-w-md mx-auto px-4">
          <Link href="/concern/new" className="btn-primary w-full sm:w-auto text-white border-transparent">Start Drafting</Link>
          <Link href="/feed" className="px-5 py-2.5 border border-base rounded-lg text-sm font-medium hover:bg-surface hover:shadow-sm transition w-full sm:w-auto">Explore Feed</Link>
        </div>
      </section>
      <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6 px-2">
        {features.map((c,i) => (
          <div key={c.title} className="card relative overflow-hidden group p-5 border border-border/60 shadow-sm hover:shadow-md transition-all">
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-br from-brand-navy/5 via-transparent to-brand-gold/10" />
            <div className="relative z-10">
              <div className="w-8 h-8 mb-3 rounded-lg bg-brand-navy/5 flex items-center justify-center text-brand-navy dark:text-brand-gold">
                <span className="font-bold font-mono text-sm">{i+1}</span>
              </div>
              <h3 className="font-bold mb-1.5 text-base text-brand-navy dark:text-white tracking-tight">{c.title}</h3>
              <p className="text-sm text-muted leading-relaxed">{c.desc}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
