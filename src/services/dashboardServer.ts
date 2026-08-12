import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telemetry } from './telemetry.ts';
import { notabotDb, businessBotDb } from './supabase.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function mountDashboardServer(app: express.Application) {

  app.use((_, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // ── Live stats from in-memory rolling counters ──
  app.get('/api/stats', (_, res) => {
    res.json(Telemetry.getStatsSnapshot());
  });

  // ── Economy leaderboard from BusinessBot Supabase ──
  app.get('/api/leaderboard', async (_, res) => {
    try {
      const { data, error } = await businessBotDb
        .from('business_users')
        .select('user_id,username,botcoin,net_worth,level,wins,losses,total_earned,total_gambled,daily_streak,stocks,inventory')
        .order('net_worth', { ascending: false })
        .limit(20);

      if (error) throw error;

      const users = (data ?? []).map(d => ({
        id: d.user_id,
        username: d.username || 'Unknown',
        botcoin: d.botcoin || 0,
        netWorth: d.net_worth || 0,
        level: d.level || 1,
        wins: d.wins || 0,
        losses: d.losses || 0,
        totalEarned: d.total_earned || 0,
        totalGambled: d.total_gambled || 0,
        dailyStreak: d.daily_streak || 0,
        stockCount: Object.values(d.stocks || {}).reduce((a: number, b: any) => a + (b as number), 0),
        inventoryCount: Object.values(d.inventory || {}).reduce((a: number, b: any) => a + (b as number), 0),
      }));
      res.json(users);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // ── Recent telemetry events from NotABot Supabase ──
  app.get('/api/events', async (_, res) => {
    try {
      const { data, error } = await notabotDb
        .from('telemetry_events')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(200);
      if (error) throw error;
      res.json(data ?? []);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  });

  // ── Economy overview ──
  app.get('/api/economy', async (_, res) => {
    try {
      const { data: users, error: usersErr } = await businessBotDb
        .from('business_users')
        .select('botcoin,net_worth,stocks,inventory');
      if (usersErr) throw usersErr;

      let totalCoins = 0, totalNetWorth = 0, totalUsers = 0, totalStockValue = 0;
      const wealthDistribution: number[] = [];

      (users ?? []).forEach(d => {
        totalUsers++;
        totalCoins += d.botcoin || 0;
        totalNetWorth += d.net_worth || 0;
        wealthDistribution.push(d.net_worth || 0);
        Object.values(d.stocks || {}).forEach((qty: any) => { totalStockValue += (qty as number) * 50; });
      });

      wealthDistribution.sort((a, b) => b - a);

      let gini = 0;
      if (wealthDistribution.length > 1) {
        const n = wealthDistribution.length;
        const mean = totalNetWorth / n;
        if (mean > 0) {
          let sumDiff = 0;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sumDiff += Math.abs(wealthDistribution[i] - wealthDistribution[j]);
          gini = sumDiff / (2 * n * n * mean);
        }
      }

      const top10Count = Math.max(1, Math.ceil(totalUsers * 0.1));
      const top10Wealth = wealthDistribution.slice(0, top10Count).reduce((a, b) => a + b, 0);
      const top10Share = totalNetWorth > 0 ? Math.round((top10Wealth / totalNetWorth) * 100) : 0;

      const { data: globalData } = await businessBotDb.from('business_global').select('bounties,auctions,trades').eq('id', 'state').maybeSingle();
      const activeBounties = Object.values(globalData?.bounties || {}).filter((b: any) => b.status === 'open').length;
      const activeAuctions = Object.values(globalData?.auctions || {}).filter((a: any) => a.status === 'active').length;
      const activeTrades   = Object.values(globalData?.trades   || {}).filter((t: any) => t.status === 'pending').length;

      res.json({
        totalUsers, totalCoins, totalNetWorth, totalStockValue,
        avgWealth: totalUsers > 0 ? Math.round(totalNetWorth / totalUsers) : 0,
        medianWealth: wealthDistribution.length > 0 ? wealthDistribution[Math.floor(wealthDistribution.length / 2)] : 0,
        giniCoefficient: Math.round(gini * 100) / 100,
        top10WealthShare: top10Share,
        activeBounties, activeAuctions, activeTrades,
        wealthDistribution: wealthDistribution.slice(0, 50),
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch economy data' });
    }
  });

  // ── EXPORT: Full JSON dump ──
  app.get('/api/export/json', (_, res) => {
    const snapshot = Telemetry.getStatsSnapshot();
    res.setHeader('Content-Disposition', `attachment; filename=notabot-metrics-${new Date().toISOString().slice(0,10)}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json({
      exportedAt: new Date().toISOString(),
      sessionStart: snapshot.sessionStart,
      uptimeMs: snapshot.uptimeMs,
      notabotIntelligence: {
        totalConversations: snapshot.totalConversations,
        totalConversationTurns: snapshot.totalConversationTurns,
        avgConversationLength: snapshot.avgConversationLength,
        falsePositives: snapshot.falsePositives,
        falsePositiveRate: snapshot.falsePositiveRate,
        ghostRates: snapshot.ghostRates,
        topicDistribution: snapshot.topicDistribution,
        sentimentDistribution: snapshot.sentimentDistribution,
        avgConfidence: snapshot.avgConfidence,
        avgBoredom: snapshot.avgBoredom,
      },
      aiDecisions: { speak: snapshot.decisionsSpeak, react: snapshot.decisionsReact, gif: snapshot.decisionsGif, play: snapshot.decisionsPlay, ignore: snapshot.decisionsIgnore, silent: snapshot.decisionsSilent },
      apiPerformance: { totalCalls: snapshot.totalApiCalls, totalTokensIn: snapshot.totalTokensIn, totalTokensOut: snapshot.totalTokensOut, avgLatencyMs: snapshot.avgApiLatency, modelUsage: snapshot.apiModelCounts },
      engagement: { totalMessages: snapshot.totalMessages, uniqueUsers: snapshot.uniqueUsers, uniqueGuilds: snapshot.uniqueGuilds, hourlyActivity: snapshot.hourlyActivity, topUsers: snapshot.topUsers, guildActivity: snapshot.guildActivity },
      economy: { totalCoinsEarned: snapshot.totalCoinsEarned, totalCoinsLost: snapshot.totalCoinsLost, inflation: snapshot.economyInflation, gambles: snapshot.totalGambles, gambleWinRate: snapshot.gambleWinRate, robs: snapshot.totalRobs, robSuccessRate: snapshot.robSuccessRate, stockBuys: snapshot.totalStockBuys, stockSells: snapshot.totalStockSells, trades: snapshot.totalTrades },
      notabotDeepMetrics: { intentFunnel: snapshot.intentFunnel, goalFunnel: snapshot.goalFunnel, sentimentShifts: snapshot.sentimentShifts, conversationDropoffs: snapshot.conversationDropoffs },
      recentEvents: snapshot.recentEvents,
    });
  });

  // ── EXPORT: CSV ──
  app.get('/api/export/csv', async (_, res) => {
    try {
      const { data: events, error } = await notabotDb
        .from('telemetry_events')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(5000);
      if (error) throw error;
      if (!events?.length) { res.status(200).send('No events yet'); return; }

      const headers = ['timestamp', 'eventType', 'userId', 'guildId', 'data'];
      const rows = events.map(e => [e.timestamp, e.event_type, e.user_id || '', e.guild_id || '', JSON.stringify(e.data || {}).replace(/"/g, '""')]);
      const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
      res.setHeader('Content-Disposition', `attachment; filename=notabot-events-${new Date().toISOString().slice(0,10)}.csv`);
      res.setHeader('Content-Type', 'text/csv');
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: 'Failed to export CSV' });
    }
  });

  // ── EXPORT: HISTORY SNAPSHOTS ──
  app.get('/api/history', async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const dateStrings: string[] = [];
      const now = new Date();
      for (let i = 0; i < days; i++) {
        const d = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
        dateStrings.push(d.toISOString().split('T')[0]);
      }

      const { data: snapshots, error } = await notabotDb
        .from('telemetry_history')
        .select('data')
        .in('date_str', dateStrings)
        .order('date_str', { ascending: true });

      if (error) throw error;
      const rows = (snapshots ?? []).map(s => s.data).sort((a: any, b: any) => a.ts - b.ts);
      res.json(rows);
    } catch (e) {
      console.error('[Dashboard] Error fetching history:', e);
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  // ── NotABot Intelligence Summary ──
  app.get('/api/notabot/intelligence', (_, res) => {
    const s = Telemetry.getStatsSnapshot();
    res.json({
      conversationFunnel: { totalConversations: s.totalConversations, totalTurns: s.totalConversationTurns, avgTurnsPerSession: s.avgConversationLength },
      frictionAnalysis: { totalFrictionEvents: s.falsePositives, frictionRate: s.falsePositiveRate, totalSpeakDecisions: s.decisionsSpeak },
      ghostAnalysis: { totalGhosted: s.ghostRates },
      topicBreakdown: s.topicDistribution,
      sentimentBreakdown: s.sentimentDistribution,
      sentimentShifts: s.sentimentShifts,
      conversationDropoffs: s.conversationDropoffs,
      intentFunnel: s.intentFunnel,
      goalFunnel: s.goalFunnel,
      brainState: { avgConfidence: s.avgConfidence, avgBoredom: s.avgBoredom },
      decisionMatrix: { speak: s.decisionsSpeak, react: s.decisionsReact, gif: s.decisionsGif, play: s.decisionsPlay, ignore: s.decisionsIgnore, silent: s.decisionsSilent },
      apiHealth: { totalCalls: s.totalApiCalls, avgLatencyMs: s.avgApiLatency, tokensIn: s.totalTokensIn, tokensOut: s.totalTokensOut },
      userEngagement: { totalMessages: s.totalMessages, uniqueUsers: s.uniqueUsers, uniqueGuilds: s.uniqueGuilds, topUsers: s.topUsers, hourlyHeatmap: s.hourlyActivity, avgResponseTimeMs: s.avgResponseTimeMs, avgTurnsPerUser: s.avgTurnsPerUser, retention: { d1: s.retentionD1, d7: s.retentionD7, d30: s.retentionD30 } },
      advancedIntelligence: { commandDiscovery: { nlpCount: s.nlpCommandCount, prefixCount: s.prefixCommandCount }, concurrency: { activeChannels: s.activeChannelsCount, peakActiveChannels: s.peakConcurrentChannels }, proactive: { successRate: s.proactiveSuccessRate }, coldOpen: { successRate: s.coldOpenSuccessRate }, serverChurn: { joins: s.guildJoins, leaves: s.guildLeaves }, memoryRecall: { successRate: s.memoryRecallSuccessRate }, emojiEffectiveness: s.topEmojis },
    });
  });

  // ── Serve static dashboard files ──
  const dashboardPath = path.resolve(__dirname, '../../dashboard/dist');
  app.use('/dashboard', express.static(dashboardPath));
  app.get('/dashboard/*', (_, res) => {
    res.sendFile(path.join(dashboardPath, 'index.html'));
  });
}
