import { useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  RadialLinearScale,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Radar } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  RadialLinearScale,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const API_BASE = 'http://localhost:4400/api';

export default function App() {
  const [stats, setStats] = useState<any>(null);
  const [economy, setEconomy] = useState<any>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, ecoRes] = await Promise.all([
          fetch(`${API_BASE}/stats`).catch(() => null),
          fetch(`${API_BASE}/economy`).catch(() => null),
        ]);
        
        if (statsRes && statsRes.ok) setStats(await statsRes.json());
        if (ecoRes && ecoRes.ok) setEconomy(await ecoRes.json());
      } catch (e) {
        console.error('Fetch error:', e);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!stats || !economy) {
    return (
      <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div className="card">
          <h3>Connecting to Telemetry Engine...</h3>
          <div className="pulse" style={{ margin: '1rem auto' }}></div>
        </div>
      </div>
    );
  }

  // --- Chart Data Preparation ---

  const activityData = {
    labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
    datasets: [
      {
        label: 'Messages',
        data: stats.hourlyActivity,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.4,
      }
    ]
  };

  const decisionData = {
    labels: ['Speak', 'React', 'GIF', 'Play', 'Ignore', 'Silent'],
    datasets: [{
      label: 'AI Decisions',
      data: [stats.decisionsSpeak, stats.decisionsReact, stats.decisionsGif, stats.decisionsPlay, stats.decisionsIgnore, stats.decisionsSilent],
      backgroundColor: 'rgba(139, 92, 246, 0.4)',
      borderColor: '#8b5cf6',
      pointBackgroundColor: '#c4b5fd',
    }]
  };
  
  const topics = Object.keys(stats.topicDistribution || {});
  const topicCounts = Object.values(stats.topicDistribution || {});
  
  const topicData = {
    labels: topics.length > 0 ? topics : ['No Data'],
    datasets: [{
      label: 'Conversation Topics',
      data: topicCounts.length > 0 ? topicCounts : [1],
      backgroundColor: ['rgba(59, 130, 246, 0.6)', 'rgba(139, 92, 246, 0.6)', 'rgba(16, 185, 129, 0.6)', 'rgba(245, 158, 11, 0.6)'],
      borderColor: ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'],
      borderWidth: 1,
    }]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#94a3b8' } }
    },
    scales: {
      x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } }
    }
  };

  const radarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      r: { 
        angleLines: { color: 'rgba(255,255,255,0.1)' },
        grid: { color: 'rgba(255,255,255,0.1)' },
        pointLabels: { color: '#94a3b8' },
        ticks: { display: false }
      }
    }
  };

  return (
    <div className="dashboard-container">
      <header className="header">
        <div>
          <h1>NotABot Intelligence Core</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Advanced Conversational Analytics</p>
        </div>
        <div className="live-indicator">
          <div className="pulse"></div>
          LIVE
        </div>
      </header>

      {/* Top Level KPIs */}
      <div className="grid grid-cols-4">
        <div className="card">
          <h3>Conversation Funnel</h3>
          <div className="value">{stats.avgConversationLength}</div>
          <div className="sub-value">Avg Turns per Session</div>
        </div>
        <div className="card">
          <h3>Friction ("Shut Up" Rate)</h3>
          <div className="value" style={{ color: stats.falsePositiveRate > 10 ? 'var(--danger)' : 'var(--success)' }}>{stats.falsePositiveRate}%</div>
          <div className="sub-value">{stats.falsePositives} Rejections / {stats.decisionsSpeak} Speaks</div>
        </div>
        <div className="card">
          <h3>Ghost Rate</h3>
          <div className="value">{stats.ghostRates}</div>
          <div className="sub-value">Unanswered AI Questions</div>
        </div>
        <div className="card">
          <h3>Brain State (Mood)</h3>
          <div className="value">{Math.round(stats.avgBoredom * 100)}%</div>
          <div className="sub-value">Avg Boredom | {Math.round(stats.avgConfidence * 100)}% Confidence</div>
        </div>
      </div>

      <div className="flex-row">
        {/* Main Chart area */}
        <div className="w-2-3 grid grid-cols-1 gap-1.5rem">
          <div className="card">
            <h3>24h Server Activity</h3>
            <div className="chart-container">
              <Line data={activityData} options={chartOptions} />
            </div>
          </div>
          <div className="grid grid-cols-2" style={{ gap: '1.5rem', marginTop: '1.5rem' }}>
            <div className="card">
              <h3>Topic Distribution</h3>
              <div className="chart-container">
                <Bar data={topicData} options={chartOptions} />
              </div>
            </div>
            <div className="card">
              <h3>NotABot Decision Matrix</h3>
              <div className="chart-container">
                <Radar data={decisionData} options={radarOptions} />
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar area */}
        <div className="w-1-3 grid grid-cols-1" style={{ gap: '1.5rem' }}>
          <div className="card">
            <h3>Sentiment Analysis</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <div>
                <div style={{ color: 'var(--success)', fontSize: '1.25rem', fontWeight: 'bold' }}>{stats.sentimentDistribution?.Positive || 0}</div>
                <div className="sub-value">Positive</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: 'var(--danger)', fontSize: '1.25rem', fontWeight: 'bold' }}>{stats.sentimentDistribution?.Negative || 0}</div>
                <div className="sub-value">Negative / Toxic</div>
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span className="sub-value">API Latency</span>
                <span>{stats.avgApiLatency}ms</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span className="sub-value">Total Tokens Processed</span>
                <span>{(stats.totalTokensIn + stats.totalTokensOut).toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="card" style={{ flexGrow: 1 }}>
            <h3>Intelligence Ticker</h3>
            <div className="ticker-tape">
              {stats.recentEvents.slice(0, 50).filter((ev:any) => !ev.eventType.includes('ECONOMY')).map((ev: any, idx: number) => {
                let typeClass = 'ai';
                if (ev.eventType.includes('NLP')) typeClass = 'nlp';
                
                let desc = JSON.stringify(ev.data).slice(0, 60) + '...';
                if (ev.eventType === 'COMMAND_EXECUTE') desc = `/${ev.data.command} ${ev.data.args?.join(' ')}`;
                if (ev.eventType === 'NOTABOT_DECISION') desc = `Decided: ${ev.data.action} (Conf: ${Math.round(ev.data.confidence*100)}%)`;
                if (ev.eventType === 'NOTABOT_FRICTION') desc = `User friction: "${ev.data.trigger}"`;
                if (ev.eventType === 'CONVERSATION_TURN') desc = `Turn: ${ev.data.topic} | ${ev.data.sentiment}`;

                return (
                  <div key={idx} className="event-item">
                    <span className="event-time">{new Date(ev.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`event-type ${typeClass}`}>{ev.eventType.replace('NOTABOT_', '')}</span>
                    <span className="event-desc">{desc}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
