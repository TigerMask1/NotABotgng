import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Power, ShieldAlert, Cpu, Database, Ghost, MessageSquare, Zap } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error("Failed to fetch status", err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {/* Main Control Card */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800 shadow-2xl relative overflow-hidden group"
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
            className="grid grid-cols-2 gap-4"
          >
            <StatusTile 
              title="AI Intelligence" 
              value={status?.hasAiKey ? 'Cognizant' : 'Missing DNA'} 
              icon={<Zap className={status?.hasAiKey ? 'text-yellow-400' : 'text-neutral-600'} />}
              active={!!status?.hasAiKey}
            />
            <StatusTile 
              title="Memory Unit" 
              value="Syncing..." 
              icon={<Database className="text-blue-400" />}
              active={isRunning}
            />
            <StatusTile 
              title="Persona" 
              value="CHAOTIC" 
              icon={<Ghost className="text-orange-400" />}
              active={true}
            />
            <StatusTile 
              title="Engagement" 
              value="Trolling" 
              icon={<MessageSquare className="text-green-400" />}
              active={isRunning}
            />
          </motion.div>
        </div>

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
