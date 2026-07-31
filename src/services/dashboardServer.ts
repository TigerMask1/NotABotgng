import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telemetry } from './telemetry.ts';
import { db } from './firebase.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let server: any = null;

export function startDashboardServer(port = 4400) {
  const app = express();
  
  app.use((_, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // ── Live stats from in-memory rolling counters ──
  app.get('/api/stats', (_, res) => {
    res.json(Telemetry.getStatsSnapshot());
  });

  // ── Economy leaderboard from Firestore ──
  app.get('/api/leaderboard', async (_, res) => {
    try {
      const snap = await db.collection('businessUsers').orderBy('netWorth', 'desc').limit(20).get();
      const users = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          username: data.username || 'Unknown',
          botcoin: data.botcoin || 0,
          netWorth: data.netWorth || 0,
          level: data.level || 1,
          wins: data.wins || 0,
          losses: data.losses || 0,
          totalEarned: data.totalEarned || 0,
          totalGambled: data.totalGambled || 0,
          dailyStreak: data.dailyStreak || 0,
          stockCount: Object.values(data.stocks || {}).reduce((a: number, b: any) => a + (b as number), 0),
          inventoryCount: Object.values(data.inventory || {}).reduce((a: number, b: any) => a + (b as number), 0),
        };
      });
      res.json(users);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // ── Recent telemetry events from Firestore (last 200) ──
  app.get('/api/events', async (_, res) => {
    try {
      const snap = await db.collection('telemetryEvents')
        .orderBy('timestamp', 'desc')
        .limit(200)
        .get();
      res.json(snap.docs.map(d => d.data()));
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  });

  // ── Economy overview ──
  app.get('/api/economy', async (_, res) => {
    try {
      const snap = await db.collection('businessUsers').get();
      let totalCoins = 0, totalNetWorth = 0, totalUsers = 0;
      let totalStockValue = 0;
      const wealthDistribution: number[] = [];
      
      snap.docs.forEach(d => {
        const data = d.data();
        totalUsers++;
        totalCoins += data.botcoin || 0;
        totalNetWorth += data.netWorth || 0;
        wealthDistribution.push(data.netWorth || 0);
        // Stock value estimation
        const stocks = data.stocks || {};
        Object.values(stocks).forEach((qty: any) => {
          totalStockValue += (qty as number) * 50; // rough avg
        });
      });

      wealthDistribution.sort((a, b) => b - a);

      // Gini coefficient calculation
      let gini = 0;
      if (wealthDistribution.length > 1) {
        const n = wealthDistribution.length;
        const mean = totalNetWorth / n;
        if (mean > 0) {
          let sumDiff = 0;
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              sumDiff += Math.abs(wealthDistribution[i] - wealthDistribution[j]);
            }
          }
          gini = sumDiff / (2 * n * n * mean);
        }
      }

      // Top 10% wealth share
      const top10Count = Math.max(1, Math.ceil(totalUsers * 0.1));
      const top10Wealth = wealthDistribution.slice(0, top10Count).reduce((a, b) => a + b, 0);
      const top10Share = totalNetWorth > 0 ? Math.round((top10Wealth / totalNetWorth) * 100) : 0;

      // Get global state for active bounties/auctions
      const globalSnap = await db.collection('businessGlobal').doc('state').get();
      const globalData = globalSnap.data() || {};
      const activeBounties = Object.values(globalData.bounties || {}).filter((b: any) => b.status === 'open').length;
      const activeAuctions = Object.values(globalData.auctions || {}).filter((a: any) => a.status === 'active').length;
      const activeTrades = Object.values(globalData.trades || {}).filter((t: any) => t.status === 'pending').length;

      res.json({
        totalUsers,
        totalCoins,
        totalNetWorth,
        totalStockValue,
        avgWealth: totalUsers > 0 ? Math.round(totalNetWorth / totalUsers) : 0,
        medianWealth: wealthDistribution.length > 0 ? wealthDistribution[Math.floor(wealthDistribution.length / 2)] : 0,
        giniCoefficient: Math.round(gini * 100) / 100,
        top10WealthShare: top10Share,
        activeBounties,
        activeAuctions,
        activeTrades,
        wealthDistribution: wealthDistribution.slice(0, 50), // top 50 for chart
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch economy data' });
    }
  });

  // ── Serve static dashboard files ──
  const dashboardPath = path.resolve(__dirname, '../../dashboard/dist');
  app.use(express.static(dashboardPath));
  app.get('*', (_, res) => {
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });

  server = app.listen(port, () => {
    console.log(`[Dashboard] Analytics dashboard running at http://localhost:${port}`);
  });

  return server;
}
