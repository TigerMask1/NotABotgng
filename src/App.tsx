import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Power, ShieldAlert, Radio, Database, KeyRound, Gauge, Ghost } from 'lucide-react';

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;

interface KeyStat {
  key: string;
  requestsToday: number;
  errorsToday: number;
  rate429sToday: number;
  onCooldown: boolean;
  cooldownSecondsLeft: number;
}
interface ModelStat {
  model: string;
  requests: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}
interface GeminiStats {
  day: string;
  keys: KeyStat[];
  models: ModelStat[];
}
interface MemoryEntry {
  guildId: string;
  entryCount: number;
  byKind: Record<string, string[]>;
}

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [gemini, setGemini] = useState<GeminiStats | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pulseHistory, setPulseHistory] = useState<number[]>(Array(40).fill(0));
  const lastTotal = useRef(0);

  const fetchStatus = async () => {
    try { setStatus(await (await fetch('/api/status')).json()); }
    catch (err) { console.error('status fetch failed', err); }
  };

  const fetchGemini = async () => {
    try {
      const data: GeminiStats = await (await fetch('/api/gemini/stats')).json();
      setGemini(data);
      const total = data.models.reduce((sum, m) => sum + m.requests, 0);
      const delta = Math.max(0, total - lastTotal.current);
      lastTotal.current = total;
      setPulseHistory(h => [...h.slice(1), delta]);
    } catch (err) { console.error('gemini stats fetch failed', err); }
  };

  const fetchMemory = async () => {
    try { setMemory(await (await fetch('/api/memory')).json()); }
    catch (err) { console.error('memory fetch failed', err); }
  };

  useEffect(() => {
    fetchStatus(); fetchMemory(); fetchGemini();
    const slow = setInterval(() => { fetchStatus(); fetchMemory(); }, 10000);
    const fast = setInterval(fetchGemini, 5000);
    return () => { clearInterval(slow); clearInterval(fast); };
  }, []);

  const handleToggle = async () => {
    setLoading(true); setError('');
    const endpoint = status?.botStatus === 'running' ? '/api/bot/stop' : '/api/bot/start';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token || undefined }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await fetchStatus();
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const isRunning = status?.botStatus === 'running';
  const totalTokensToday = gemini?.models.reduce((s, m) => s + m.totalTokens, 0) ?? 0;
  const totalReqToday = gemini?.models.reduce((s, m) => s + m.requests, 0) ?? 0;

  return (
    <div
      className="min-h-screen"
      style={{ background: '#0A0C10', color: '#F2EFE9', fontFamily: "'Space Grotesk', sans-serif" }}
    >
      <style>{FONT_IMPORT}</style>

      <main className="max-w-5xl mx-auto px-6 py-10 lg:py-16">
        {/* Header */}
        <header className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              {isRunning && (
                <span
                  className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                  style={{ background: '#E8A33D' }}
                />
              )}
              <span
                className="relative inline-flex rounded-full h-3 w-3"
                style={{ background: isRunning ? '#E8A33D' : '#E24B4B' }}
              />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight" style={{ color: '#F2EFE9' }}>NotABot</h1>
              <p className="text-xs uppercase tracking-[0.2em]" style={{ color: '#8A8F98' }}>
                {isRunning ? 'alive' : 'offline'} · operator console
              </p>
            </div>
          </div>

          <button
            onClick={handleToggle}
            disabled={loading || (!status?.hasToken && !token && !isRunning)}
            className="px-5 py-2.5 rounded-xl text-sm font-medium tracking-wide flex items-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: isRunning ? '#14171C' : '#E8A33D',
              color: isRunning ? '#F2EFE9' : '#0A0C10',
              border: `1px solid ${isRunning ? '#262B33' : '#E8A33D'}`,
            }}
          >
            {loading
              ? <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#F2EFE9' }} />
              : <Power className="w-4 h-4" />}
            {isRunning ? 'Stop' : 'Start'}
          </button>
        </header>

        {!status?.hasToken && !isRunning && (
          <div className="mb-8">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Discord bot token"
              className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none"
              style={{ background: '#14171C', border: '1px solid #262B33', color: '#F2EFE9' }}
            />
          </div>
        )}

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              className="mb-8 p-4 rounded-xl text-sm flex items-start gap-2"
              style={{ background: 'rgba(226,75,75,0.1)', border: '1px solid rgba(226,75,75,0.3)', color: '#E24B4B' }}
            >
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Vitals strip — signature element: a live pulse line built from real
            request deltas each poll. flatlines when nothing's happening,
            spikes on activity — the thing this console exists to show. */}
        <section
          className="mb-8 rounded-2xl p-6"
          style={{ background: '#14171C', border: '1px solid #262B33' }}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4" style={{ color: '#E8A33D' }} />
              <span className="text-xs uppercase tracking-[0.2em]" style={{ color: '#8A8F98' }}>Vitals</span>
            </div>
            <span className="text-[11px]" style={{ fontFamily: "'IBM Plex Mono', monospace", color: '#8A8F98' }}>
              {gemini?.day ? `day: ${gemini.day} · resets midnight PT` : '—'}
            </span>
          </div>

          <PulseLine values={pulseHistory} color="#E8A33D" />

          <div className="grid grid-cols-3 gap-4 mt-5">
            <Metric label="requests today" value={totalReqToday.toLocaleString()} accent="#E8A33D" />
            <Metric label="tokens today" value={totalTokensToday.toLocaleString()} accent="#4FA8C9" />
            <Metric label="keys active" value={`${gemini?.keys.filter(k => !k.onCooldown).length ?? 0} / ${gemini?.keys.length ?? 0}`} accent="#F2EFE9" />
          </div>
        </section>

        {/* Per-key live status */}
        <section className="mb-8">
          <SectionHeader icon={<KeyRound className="w-4 h-4" />} title="API Keys" sub={`${gemini?.keys.length ?? 0} loaded`} />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {gemini?.keys.length ? gemini.keys.map(k => <KeyCard key={k.key} k={k} />) : (
              <EmptyState text="No key data yet — start the bot to see live usage." />
            )}
          </div>
        </section>

        {/* Per-model token usage */}
        <section className="mb-8">
          <SectionHeader icon={<Gauge className="w-4 h-4" />} title="Models" sub="requests & tokens today" />
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #262B33' }}>
            {gemini?.models.length ? gemini.models.map((m, i) => (
              <ModelRow key={m.model} m={m} isLast={i === gemini.models.length - 1} maxTokens={Math.max(...gemini.models.map(x => x.totalTokens), 1)} />
            )) : (
              <div className="p-6"><EmptyState text="No model activity recorded today." /></div>
            )}
          </div>
        </section>

        {/* Memory */}
        <section className="mb-8">
          <SectionHeader icon={<Database className="w-4 h-4" />} title="Memory" sub="per server, by kind" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {memory.length ? memory.map(s => <MemoryCard key={s.guildId} s={s} />) : (
              <EmptyState text="No memory recorded yet." />
            )}
          </div>
        </section>

        <footer className="mt-16 pt-8 text-center" style={{ borderTop: '1px solid #262B33' }}>
          <p className="text-[11px] tracking-[0.2em] uppercase" style={{ color: '#8A8F98', fontFamily: "'IBM Plex Mono', monospace" }}>
            NotABot · gemini multi-key runtime
          </p>
        </footer>
      </main>
    </div>
  );
}

function SectionHeader({ icon, title, sub }: { icon: any; title: string; sub: string }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2" style={{ color: '#F2EFE9' }}>
        <span style={{ color: '#4FA8C9' }}>{icon}</span>
        <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
      </div>
      <span className="text-[11px]" style={{ color: '#8A8F98' }}>{sub}</span>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.15em] mb-1" style={{ color: '#8A8F98' }}>{label}</p>
      <p className="text-xl font-semibold" style={{ fontFamily: "'IBM Plex Mono', monospace", color: accent }}>{value}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="col-span-full py-10 text-center rounded-2xl" style={{ border: '1px dashed #262B33' }}>
      <Ghost className="w-6 h-6 mx-auto mb-2" style={{ color: '#262B33' }} />
      <p className="text-sm" style={{ color: '#8A8F98' }}>{text}</p>
    </div>
  );
}

function KeyCard({ k }: { k: KeyStat }) {
  return (
    <div className="p-5 rounded-2xl" style={{ background: '#14171C', border: `1px solid ${k.onCooldown ? 'rgba(226,75,75,0.4)' : '#262B33'}` }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm" style={{ fontFamily: "'IBM Plex Mono', monospace", color: '#F2EFE9' }}>{k.key}</span>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide"
          style={{
            background: k.onCooldown ? 'rgba(226,75,75,0.12)' : 'rgba(232,163,61,0.12)',
            color: k.onCooldown ? '#E24B4B' : '#E8A33D',
          }}
        >
          {k.onCooldown ? `cooldown ${k.cooldownSecondsLeft}s` : 'ready'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat label="reqs" value={k.requestsToday} />
        <MiniStat label="429s" value={k.rate429sToday} warn={k.rate429sToday > 0} />
        <MiniStat label="errs" value={k.errorsToday} warn={k.errorsToday > 0} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <p className="text-base font-medium" style={{ fontFamily: "'IBM Plex Mono', monospace", color: warn ? '#E24B4B' : '#F2EFE9' }}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide" style={{ color: '#8A8F98' }}>{label}</p>
    </div>
  );
}

function ModelRow({ m, isLast, maxTokens }: { m: ModelStat; isLast: boolean; maxTokens: number }) {
  const pct = Math.max(2, Math.round((m.totalTokens / maxTokens) * 100));
  return (
    <div className="p-5" style={{ background: '#14171C', borderBottom: isLast ? 'none' : '1px solid #262B33' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: '#F2EFE9' }}>{m.model}</span>
        <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: '#8A8F98' }}>
          {m.requests.toLocaleString()} req · {m.promptTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: '#0A0C10' }}>
        <motion.div
          initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6 }}
          className="h-full rounded-full" style={{ background: '#4FA8C9' }}
        />
      </div>
    </div>
  );
}

function MemoryCard({ s }: { s: MemoryEntry }) {
  const kinds = Object.entries(s.byKind);
  return (
    <div className="p-5 rounded-2xl" style={{ background: '#14171C', border: '1px solid #262B33' }}>
      <p className="text-[10px] uppercase tracking-wide mb-3 truncate" style={{ fontFamily: "'IBM Plex Mono', monospace", color: '#8A8F98' }}>
        {s.guildId} · {s.entryCount} entries
      </p>
      {kinds.length ? kinds.map(([kind, texts]) => (
        <div key={kind} className="mb-3 last:mb-0">
          <p className="text-xs mb-1.5 font-medium capitalize" style={{ color: '#4FA8C9' }}>{kind}</p>
          <div className="flex flex-wrap gap-1.5">
            {texts.slice(0, 4).map((t, i) => (
              <span key={i} className="px-2 py-0.5 rounded-md text-[10px] truncate max-w-[160px]" style={{ background: 'rgba(79,168,201,0.1)', border: '1px solid rgba(79,168,201,0.2)', color: '#F2EFE9' }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      )) : <p className="text-xs italic" style={{ color: '#8A8F98' }}>Nothing stored yet.</p>}
    </div>
  );
}

// the signature element: a live sparkline built from actual request deltas,
// polled every 5s. this is a vitals monitor for a thing pretending to be
// alive — so the chart IS a pulse, not a decorative flourish.
function PulseLine({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  const w = 600, h = 60;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${h - (v / max) * (h - 8) - 4}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 60 }} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <polyline points={`0,${h} ${points} ${w},${h}`} fill={color} opacity={0.08} stroke="none" />
    </svg>
  );
}
