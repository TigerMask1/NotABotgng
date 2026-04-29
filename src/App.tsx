import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Power, ShieldAlert, Cpu, Database, Ghost, MessageSquare, Zap } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [memory, setMemory] = useState<any[]>([]);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error("Failed to fetch status", err);
    }
  };

  const fetchMemory = async () => {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json();
      setMemory(data);
    } catch (err) {
      console.error("Failed to fetch memory", err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchMemory();
    const interval = setInterval(() => {
      fetchStatus();
      fetchMemory();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    setLoading(true);
    setError('');
    const endpoint = status?.botStatus === 'running' ? '/api/bot/stop' : '/api/bot/start';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token || undefined })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const isRunning = status?.botStatus === 'running';

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans selection:bg-purple-500/30">
      {/* Abstract Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute top-1/2 -right-24 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl" />
      </div>

      <main className="relative z-10 max-w-4xl mx-auto px-6 py-12 lg:py-24">
        {/* Header */}
        <header className="mb-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/20 rounded-2xl border border-purple-500/20">
              <Ghost className="w-8 h-8 text-purple-400" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white mb-1">ChaosBot</h1>
              <div className="flex items-center gap-2">
                <p className="text-neutral-400 text-sm font-medium">The Sentient Discord Troll</p>
                <span className="px-1.5 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-[10px] text-blue-400 font-bold tracking-widest uppercase">Web Service</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`flex h-2 w-2 rounded-full ${isRunning ? 'bg-green-500 animate-ping' : 'bg-red-500'}`} />
            <span className="text-xs font-mono uppercase tracking-widest text-neutral-500">
              {isRunning ? 'System Operational' : 'Offline'}
            </span>
          </div>
        </header>

        {/* Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
          {/* Main Control Card */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="lg:col-span-2 p-8 rounded-3xl bg-neutral-900 border border-neutral-800 shadow-2xl relative overflow-hidden group"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative z-10">
              <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                <Power className="w-5 h-5 text-purple-400" />
                Vitals
              </h2>

              {!status?.hasToken && !isRunning && (
                <div className="mb-6">
                  <label className="block text-xs font-mono text-neutral-500 uppercase mb-2 tracking-wider">Discord Bot Token</label>
                  <input 
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Enter token..."
                    className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-purple-500 transition-colors"
                  />
                </div>
              )}

              <button 
                onClick={handleToggle}
                disabled={loading || (!status?.hasToken && !token && !isRunning)}
                className={`w-full py-4 rounded-xl font-bold text-sm tracking-wide transition-all flex items-center justify-center gap-2 shadow-lg shadow-black/20 ${
                  isRunning 
                    ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300' 
                    : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Power className="w-4 h-4" />
                    {isRunning ? 'Kill Switch' : 'Ignite System'}
                  </>
                )}
              </button>

              <AnimatePresence>
                {error && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2"
                  >
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Stats/Status Card */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col gap-4"
          >
            <StatusTile 
              title="AI Intelligence" 
              value={status?.hasAiKey ? 'Cognizant' : 'Missing DNA'} 
              icon={<Zap className={status?.hasAiKey ? 'text-yellow-400' : 'text-neutral-600'} />}
              active={!!status?.hasAiKey}
            />
            <StatusTile 
              title="Persona" 
              value="CHAOTIC" 
              icon={<Ghost className="text-orange-400" />}
              active={true}
            />
          </motion.div>
        </div>

        {/* Memory Grid */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-400" />
              Learned Memory
            </h3>
            <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Real-time Sync</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {memory.length > 0 ? memory.map((s) => (
              <div key={s.guildId} className="p-6 rounded-3xl bg-neutral-900 border border-neutral-800">
                <p className="text-[10px] font-mono text-neutral-500 uppercase mb-3 truncate">ID: {s.guildId}</p>
                <div className="mb-4">
                  <span className="text-xs text-neutral-400 block mb-2 font-medium">Inside Jokes:</span>
                  <div className="flex flex-wrap gap-2">
                    {s.jokes.length > 0 ? s.jokes.map((j: string, i: number) => (
                      <span key={i} className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] rounded-lg">
                        {j}
                      </span>
                    )) : <span className="text-xs text-neutral-600 italic">No jokes learned yet.</span>}
                  </div>
                </div>
                <div>
                  <span className="text-xs text-neutral-400 block mb-1 font-medium">Current Mood:</span>
                  <p className="text-sm font-bold text-white capitalize">{s.mood}</p>
                </div>
              </div>
            )) : (
              <div className="col-span-full py-12 text-center border border-dashed border-neutral-800 rounded-3xl">
                <Ghost className="w-8 h-8 text-neutral-800 mx-auto mb-3" />
                <p className="text-neutral-500 text-sm">No servers found. Ignite the bot to start learning.</p>
              </div>
            )}
          </div>
        </section>

        <section className="mt-8 p-8 rounded-3xl bg-purple-500/10 border border-purple-500/20">
          <h3 className="text-lg font-semibold mb-4 text-purple-300">Quick Start Guide</h3>
          <ol className="list-decimal list-inside space-y-4 text-sm text-neutral-300">
            <li>
              <strong>Invite the Bot:</strong> Use the Discord Developer Portal to generate an invite link with <code className="bg-black/40 px-1.5 py-0.5 rounded">bot</code> and <code className="bg-black/40 px-1.5 py-0.5 rounded">applications.commands</code> scopes, and <code className="bg-black/40 px-1.5 py-0.5 rounded">Administrator</code> permissions.
            </li>
            <li>
              <strong>Interaction:</strong> Ping the bot with <code className="bg-black/40 px-1.5 py-0.5 rounded">@ChaosBot</code> to start chatting. It will also randomly chime in on 3% of all messages.
            </li>
            <li>
              <strong>Learning:</strong> The more people chat, the more the bot learns. It will automatically start assigning nicknames and using inside jokes after a few interactions.
            </li>
          </ol>
        </section>

        {/* Info Section */}
        <section className="mt-12 p-8 rounded-3xl bg-neutral-900/50 border border-neutral-800/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-neutral-800 rounded-lg">
              <Cpu className="w-5 h-5 text-neutral-400" />
            </div>
            <h3 className="text-lg font-semibold">Bot Capabilities</h3>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureItem title="Contextual Memory" desc="Learns names, nicknames, and how people interact in the server." />
            <FeatureItem title="Inside Joke Engine" desc="Identifies repetative patterns and starts using them against members." />
            <FeatureItem title="Synthetic Emotion" desc="Responses designed to sound like a real person having a bad (but funny) day." />
            <FeatureItem title="Proactive Trolling" desc="Doesn't just wait for pings—occasionally interrupts with random nonsense." />
            <FeatureItem title="Smart Tokens" desc="Optimized context management to keep interactions sharp and cost-effective." />
            <FeatureItem title="Rich Media" desc="Automated GIF discovery and emoji-heavy vernacular." />
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-24 text-center border-t border-neutral-900 pt-12">
          <p className="text-neutral-500 text-xs font-mono tracking-widest uppercase">
            ChaosBot Framework v1.0.4 // Sentient Intelligence Module
          </p>
        </footer>
      </main>
    </div>
  );
}

function StatusTile({ title, value, icon, active }: { title: string, value: string, icon: any, active: boolean }) {
  return (
    <div className={`p-6 rounded-3xl border transition-all ${active ? 'bg-neutral-900 border-neutral-800' : 'bg-neutral-950 border-neutral-900 grayscale opacity-40'}`}>
      <div className="mb-4">{icon}</div>
      <p className="text-neutral-500 text-[10px] font-mono uppercase tracking-widest mb-1">{title}</p>
      <p className="font-bold text-white tracking-tight">{value}</p>
    </div>
  );
}

function FeatureItem({ title, desc }: { title: string, desc: string }) {
  return (
    <div>
      <h4 className="text-neutral-200 font-medium mb-1 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
        {title}
      </h4>
      <p className="text-neutral-500 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
