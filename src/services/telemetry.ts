import { notabotDb } from './supabase.ts';

// ════════════════════════════════════════════════════════════════════════════
// TELEMETRY ENGINE — Enterprise-grade, non-blocking data collection
// ════════════════════════════════════════════════════════════════════════════

export interface TelemetryEvent {
  eventType: string;
  timestamp: string;
  hour: number;
  dayOfWeek: number;
  userId?: string;
  username?: string;
  guildId?: string;
  channelId?: string;
  data: Record<string, any>;
}

// ── Rolling counters for the Express API (in-memory, no extra DB reads) ──
interface RollingStats {
  totalMessages: number;
  totalCommands: number;
  totalApiCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalApiLatencyMs: number;
  totalNlpCalls: number;
  totalNlpFailures: number;
  totalNlpLatencyMs: number;
  totalCoinsEarned: number;
  totalCoinsLost: number;
  totalGambles: number;
  totalGambleWins: number;
  totalGambleLosses: number;
  totalStockBuys: number;
  totalStockSells: number;
  totalShopPurchases: number;
  totalRobs: number;
  totalRobSuccesses: number;
  totalTrades: number;
  totalBountiesPosted: number;
  totalBountiesAwarded: number;
  totalForges: number;
  totalAuctions: number;
  decisionsSpeak: number;
  decisionsReact: number;
  decisionsGif: number;
  decisionsPlay: number;
  decisionsIgnore: number;
  decisionsSilent: number;
  totalDMs: number;
  uniqueUsers: Set<string>;
  uniqueGuilds: Set<string>;
  commandCounts: Record<string, number>;
  userMessageCounts: Record<string, number>;
  userCommandCounts: Record<string, number>;
  hourlyActivity: number[];
  guildActivity: Record<string, number>;
  channelActivity: Record<string, number>;
  apiModelCounts: Record<string, number>;
  totalConversations: number;
  totalConversationTurns: number;
  falsePositives: number;
  falseNegatives: number;
  ghostRates: number;
  topicDistribution: Record<string, number>;
  sentimentDistribution: Record<string, number>;
  avgConfidence: number;
  avgBoredom: number;
  userSessionTurns: Record<string, number>;
  totalResponseTimeMs: number;
  responseCount: number;
  firstSeenDates: Record<string, number>;
  retentionD1: number;
  retentionD7: number;
  retentionD30: number;
  nlpCommandCount: number;
  prefixCommandCount: number;
  activeChannelsCount: number;
  peakConcurrentChannels: number;
  emojiUsages: Record<string, number>;
  emojiFollowUps: Record<string, number>;
  proactiveStarts: number;
  proactiveSuccesses: number;
  coldOpens: number;
  coldOpenSuccesses: number;
  guildJoins: number;
  guildLeaves: number;
  memoryRecalls: number;
  memoryRecallSuccesses: number;
  intentsCreated: number;
  intentsSurfaced: number;
  intentsResolved: number;
  goalsSet: number;
  goalsCompleted: number;
  goalsAbandoned: number;
  totalGoalAgeMs: number;
  sessionSentiments: Record<string, { start: string, end: string, startMs: number, endMs: number }>;
  conversationDropoffs: Record<string, number>;
  recentEvents: TelemetryEvent[];
  sessionStart: string;
}

function freshStats(): RollingStats {
  return {
    totalMessages: 0, totalCommands: 0, totalApiCalls: 0,
    totalTokensIn: 0, totalTokensOut: 0, totalApiLatencyMs: 0,
    totalNlpCalls: 0, totalNlpFailures: 0, totalNlpLatencyMs: 0,
    totalCoinsEarned: 0, totalCoinsLost: 0, totalGambles: 0,
    totalGambleWins: 0, totalGambleLosses: 0, totalStockBuys: 0,
    totalStockSells: 0, totalShopPurchases: 0, totalRobs: 0,
    totalRobSuccesses: 0, totalTrades: 0, totalBountiesPosted: 0,
    totalBountiesAwarded: 0, totalForges: 0, totalAuctions: 0,
    decisionsSpeak: 0, decisionsReact: 0, decisionsGif: 0,
    decisionsPlay: 0, decisionsIgnore: 0, decisionsSilent: 0,
    totalDMs: 0, uniqueUsers: new Set(), uniqueGuilds: new Set(),
    commandCounts: {}, userMessageCounts: {}, userCommandCounts: {},
    hourlyActivity: new Array(24).fill(0), guildActivity: {},
    channelActivity: {}, apiModelCounts: {},
    totalConversations: 0, totalConversationTurns: 0,
    falsePositives: 0, falseNegatives: 0, ghostRates: 0,
    topicDistribution: {}, sentimentDistribution: {},
    avgConfidence: 0, avgBoredom: 0,
    userSessionTurns: {}, totalResponseTimeMs: 0, responseCount: 0,
    firstSeenDates: {}, retentionD1: 0, retentionD7: 0, retentionD30: 0,
    nlpCommandCount: 0, prefixCommandCount: 0,
    activeChannelsCount: 0, peakConcurrentChannels: 0,
    emojiUsages: {}, emojiFollowUps: {},
    proactiveStarts: 0, proactiveSuccesses: 0,
    coldOpens: 0, coldOpenSuccesses: 0,
    guildJoins: 0, guildLeaves: 0,
    memoryRecalls: 0, memoryRecallSuccesses: 0,
    intentsCreated: 0, intentsSurfaced: 0, intentsResolved: 0,
    goalsSet: 0, goalsCompleted: 0, goalsAbandoned: 0, totalGoalAgeMs: 0,
    sessionSentiments: {}, conversationDropoffs: {},
    recentEvents: [], sessionStart: new Date().toISOString()
  };
}

class TelemetryEngine {
  private buffer: TelemetryEvent[] = [];
  private batchSize = 50;
  private flushIntervalMs = 15_000;
  private interval: NodeJS.Timeout | null = null;
  public stats: RollingStats = freshStats();
  private isLoaded = false;

  private snapshotIntervalMs = 60 * 60 * 1000;
  private snapshotInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.interval = setInterval(() => this.flush(), this.flushIntervalMs);
    this.snapshotInterval = setInterval(() => this.takeHourlySnapshot(), this.snapshotIntervalMs);
  }

  private async takeHourlySnapshot() {
    if (!this.isLoaded) return;
    try {
      const snap = this.getStatsSnapshot();
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const hourStr = now.getHours().toString().padStart(2, '0');

      await notabotDb.from('telemetry_history').upsert({
        date_str: dateStr,
        hour_str: hourStr,
        data: {
          ts: now.getTime(),
          messages: snap.totalMessages,
          conversations: snap.totalConversations,
          decisionsSpeak: snap.decisionsSpeak,
          decisionsIgnore: snap.decisionsIgnore,
          avgBoredom: snap.avgBoredom,
          avgConfidence: snap.avgConfidence,
          intentsCreated: snap.intentFunnel.created,
          intentsResolved: snap.intentFunnel.resolved,
          coldOpens: snap.coldOpens,
          coldOpenSuccess: snap.coldOpenSuccesses
        }
      }, { onConflict: 'date_str,hour_str' });
    } catch (e) {
      console.error('[Telemetry] failed to save hourly snapshot:', e);
    }
  }

  public async loadFromDb() {
    try {
      const { data } = await notabotDb
        .from('telemetry_global')
        .select('data')
        .eq('id', 'rollingStats')
        .maybeSingle();

      if (data?.data) {
        const saved = data.data as Partial<RollingStats>;
        const fresh = freshStats();
        if (saved.uniqueUsers) this.stats.uniqueUsers = new Set(saved.uniqueUsers as any);
        if (saved.uniqueGuilds) this.stats.uniqueGuilds = new Set(saved.uniqueGuilds as any);
        for (const key of Object.keys(fresh) as Array<keyof RollingStats>) {
          if (key === 'uniqueUsers' || key === 'uniqueGuilds' || key === 'recentEvents' || key === 'sessionStart') continue;
          if ((saved as any)[key] !== undefined) (this.stats as any)[key] = (saved as any)[key];
        }
        console.log('[Telemetry] Loaded historic rolling stats from Supabase.');
      }
      this.isLoaded = true;
    } catch (e) {
      console.error('[Telemetry] Failed to load historic stats:', e);
      this.isLoaded = true;
    }
  }

  /** Fire-and-forget event tracking — never throws, never blocks */
  public track(
    eventType: string,
    data: Record<string, any>,
    userId?: string,
    guildId?: string,
    extra?: { username?: string; channelId?: string }
  ) {
    const now = new Date();
    const event: TelemetryEvent = {
      eventType,
      timestamp: now.toISOString(),
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
      userId,
      username: extra?.username,
      guildId,
      channelId: extra?.channelId,
      data
    };

    Object.keys(event).forEach(key => {
      if ((event as any)[key] === undefined) delete (event as any)[key];
    });

    this.buffer.push(event);
    this.updateRollingStats(event);

    this.stats.recentEvents.push(event);
    if (this.stats.recentEvents.length > 100) this.stats.recentEvents.shift();

    if (this.buffer.length >= this.batchSize) this.flush();
  }

  private updateRollingStats(e: TelemetryEvent) {
    const s = this.stats;
    if (e.userId) s.uniqueUsers.add(e.userId);
    if (e.guildId && e.guildId !== 'DM') s.uniqueGuilds.add(e.guildId);
    s.hourlyActivity[e.hour]++;
    if (e.guildId) s.guildActivity[e.guildId] = (s.guildActivity[e.guildId] || 0) + 1;
    if (e.channelId) s.channelActivity[e.channelId] = (s.channelActivity[e.channelId] || 0) + 1;

    switch (e.eventType) {
      case 'MESSAGE_RECEIVED':
        s.totalMessages++;
        if (e.userId) s.userMessageCounts[e.userId] = (s.userMessageCounts[e.userId] || 0) + 1;
        if (e.guildId === 'DM') s.totalDMs++;
        break;
      case 'COMMAND_EXECUTE':
        s.totalCommands++;
        const cmd = e.data.command as string;
        s.commandCounts[cmd] = (s.commandCounts[cmd] || 0) + 1;
        if (e.userId) s.userCommandCounts[e.userId] = (s.userCommandCounts[e.userId] || 0) + 1;
        if (e.data.isNlp) s.nlpCommandCount++; else s.prefixCommandCount++;
        break;
      case 'NOTABOT_API_CALL':
        s.totalApiCalls++;
        s.totalTokensIn += e.data.inTokens || 0;
        s.totalTokensOut += e.data.outTokens || 0;
        s.totalApiLatencyMs += e.data.durationMs || 0;
        const model = e.data.model || 'unknown';
        s.apiModelCounts[model] = (s.apiModelCounts[model] || 0) + 1;
        break;
      case 'NOTABOT_DECISION':
        switch (e.data.action) {
          case 'speak': s.decisionsSpeak++; break;
          case 'react': s.decisionsReact++; break;
          case 'gif':   s.decisionsGif++;   break;
          case 'play':  s.decisionsPlay++;  break;
          case 'ignore': s.decisionsIgnore++; break;
          case 'silent': s.decisionsSilent++; break;
        }
        if (e.data.confidence) s.avgConfidence = s.avgConfidence === 0 ? e.data.confidence : (s.avgConfidence * 0.9) + (e.data.confidence * 0.1);
        if (e.data.boredom) s.avgBoredom = s.avgBoredom === 0 ? e.data.boredom : (s.avgBoredom * 0.9) + (e.data.boredom * 0.1);
        break;
      case 'CONVERSATION_TURN':
        s.totalConversationTurns++;
        if (e.data.isNew) s.totalConversations++;
        if (e.data.topic) s.topicDistribution[e.data.topic] = (s.topicDistribution[e.data.topic] || 0) + 1;
        if (e.data.sentiment) s.sentimentDistribution[e.data.sentiment] = (s.sentimentDistribution[e.data.sentiment] || 0) + 1;
        break;
      case 'NOTABOT_FRICTION':
        if (e.data.type === 'FALSE_POSITIVE') s.falsePositives++;
        if (e.data.type === 'FALSE_NEGATIVE') s.falseNegatives++;
        break;
      case 'NOTABOT_GHOSTED': s.ghostRates++; break;
      case 'NLP_PROCESSED': s.totalNlpCalls++; s.totalNlpLatencyMs += e.data.durationMs || 0; break;
      case 'NLP_FAILED': s.totalNlpCalls++; s.totalNlpFailures++; s.totalNlpLatencyMs += e.data.durationMs || 0; break;
      case 'ECONOMY_GAMBLE':
        s.totalGambles++;
        if (e.data.won) { s.totalGambleWins++; s.totalCoinsEarned += e.data.payout || 0; }
        else { s.totalGambleLosses++; s.totalCoinsLost += e.data.amount || 0; }
        break;
      case 'ECONOMY_ROB': s.totalRobs++; if (e.data.success) s.totalRobSuccesses++; break;
      case 'ECONOMY_STOCK_BUY':  s.totalStockBuys++;  break;
      case 'ECONOMY_STOCK_SELL': s.totalStockSells++; break;
      case 'ECONOMY_SHOP_BUY':  s.totalShopPurchases++; break;
      case 'ECONOMY_TRADE':     s.totalTrades++;     break;
      case 'ECONOMY_BOUNTY_POST':  s.totalBountiesPosted++;  break;
      case 'ECONOMY_BOUNTY_AWARD': s.totalBountiesAwarded++; break;
      case 'ECONOMY_FORGE':     s.totalForges++;     break;
      case 'ECONOMY_AUCTION':   s.totalAuctions++;   break;
      case 'ECONOMY_DAILY':     s.totalCoinsEarned += e.data.amount || 0; break;
      case 'ECONOMY_WAGER':     s.totalGambles++; break;
      case 'SESSION_TURN_DEPTH':
        if (e.userId) s.userSessionTurns[e.userId] = Math.max(s.userSessionTurns[e.userId] || 0, e.data.turns || 0);
        break;
      case 'RESPONSE_TIME': s.totalResponseTimeMs += e.data.latencyMs || 0; s.responseCount++; break;
      case 'USER_SEEN':
        if (e.userId) {
          const nowMs = Date.now();
          if (!s.firstSeenDates[e.userId]) { s.firstSeenDates[e.userId] = nowMs; }
          else {
            const d = (nowMs - s.firstSeenDates[e.userId]) / (1000 * 60 * 60 * 24);
            if (d >= 1 && d < 2) s.retentionD1++;
            else if (d >= 7 && d < 8) s.retentionD7++;
            else if (d >= 30 && d < 31) s.retentionD30++;
          }
        }
        break;
      case 'CHANNEL_MODE_CHANGE':
        if (e.data.mode === 'active') { s.activeChannelsCount++; if (s.activeChannelsCount > s.peakConcurrentChannels) s.peakConcurrentChannels = s.activeChannelsCount; }
        else if (e.data.mode === 'passive' && s.activeChannelsCount > 0) s.activeChannelsCount--;
        break;
      case 'EMOJI_USED': if (e.data.emoji) s.emojiUsages[e.data.emoji] = (s.emojiUsages[e.data.emoji] || 0) + 1; break;
      case 'EMOJI_FOLLOW_UP': if (e.data.emoji) s.emojiFollowUps[e.data.emoji] = (s.emojiFollowUps[e.data.emoji] || 0) + 1; break;
      case 'PROACTIVE_START': s.proactiveStarts++; break;
      case 'PROACTIVE_SUCCESS': s.proactiveSuccesses++; break;
      case 'COLD_OPEN_START': s.coldOpens++; break;
      case 'COLD_OPEN_SUCCESS': s.coldOpenSuccesses++; break;
      case 'GUILD_JOIN': s.guildJoins++; break;
      case 'GUILD_LEAVE': s.guildLeaves++; break;
      case 'MEMORY_RECALL_USED': s.memoryRecalls++; break;
      case 'MEMORY_RECALL_SUCCESS': s.memoryRecallSuccesses++; break;
      case 'INTENT_CREATED': s.intentsCreated++; break;
      case 'INTENT_SURFACED': s.intentsSurfaced++; break;
      case 'INTENT_RESOLVED': s.intentsResolved++; break;
      case 'GOAL_SET': s.goalsSet++; break;
      case 'GOAL_COMPLETED': s.goalsCompleted++; if (e.data.ageMs) s.totalGoalAgeMs += e.data.ageMs; break;
      case 'GOAL_ABANDONED': s.goalsAbandoned++; if (e.data.ageMs) s.totalGoalAgeMs += e.data.ageMs; break;
      case 'CONVERSATION_START':
        if (e.userId && e.data.sentiment) s.sessionSentiments[e.userId] = { start: e.data.sentiment, end: e.data.sentiment, startMs: Date.now(), endMs: Date.now() };
        break;
      case 'CONVERSATION_UPDATE':
        if (e.userId && e.data.sentiment && s.sessionSentiments[e.userId]) { s.sessionSentiments[e.userId].end = e.data.sentiment; s.sessionSentiments[e.userId].endMs = Date.now(); }
        break;
      case 'CONVERSATION_DROPOFF':
        if (e.userId) { const depth = e.data.turnDepth || 0; s.conversationDropoffs[depth] = (s.conversationDropoffs[depth] || 0) + 1; }
        break;
    }
  }

  public getStatsSnapshot(): Record<string, any> {
    const s = this.stats;
    return {
      ...s,
      uniqueUsers: s.uniqueUsers.size,
      uniqueGuilds: s.uniqueGuilds.size,
      uniqueUsersList: [...s.uniqueUsers],
      avgApiLatency: s.totalApiCalls > 0 ? Math.round(s.totalApiLatencyMs / s.totalApiCalls) : 0,
      avgNlpLatency: s.totalNlpCalls > 0 ? Math.round(s.totalNlpLatencyMs / s.totalNlpCalls) : 0,
      nlpSuccessRate: s.totalNlpCalls > 0 ? Math.round(((s.totalNlpCalls - s.totalNlpFailures) / s.totalNlpCalls) * 100) : 100,
      gambleWinRate: s.totalGambles > 0 ? Math.round((s.totalGambleWins / s.totalGambles) * 100) : 0,
      robSuccessRate: s.totalRobs > 0 ? Math.round((s.totalRobSuccesses / s.totalRobs) * 100) : 0,
      economyInflation: s.totalCoinsEarned - s.totalCoinsLost,
      avgConversationLength: s.totalConversations > 0 ? (s.totalConversationTurns / s.totalConversations).toFixed(1) : 0,
      falsePositiveRate: s.decisionsSpeak > 0 ? ((s.falsePositives / s.decisionsSpeak) * 100).toFixed(1) : 0,
      uptimeMs: Date.now() - new Date(s.sessionStart).getTime(),
      avgResponseTimeMs: s.responseCount > 0 ? Math.round(s.totalResponseTimeMs / s.responseCount) : 0,
      retentionD1: s.retentionD1, retentionD7: s.retentionD7, retentionD30: s.retentionD30,
      nlpCommandCount: s.nlpCommandCount, prefixCommandCount: s.prefixCommandCount,
      peakConcurrentChannels: s.peakConcurrentChannels, activeChannelsCount: s.activeChannelsCount,
      proactiveSuccessRate: s.proactiveStarts > 0 ? Math.round((s.proactiveSuccesses / s.proactiveStarts) * 100) : 0,
      coldOpenSuccessRate: s.coldOpens > 0 ? Math.round((s.coldOpenSuccesses / s.coldOpens) * 100) : 0,
      guildJoins: s.guildJoins, guildLeaves: s.guildLeaves,
      memoryRecallSuccessRate: s.memoryRecalls > 0 ? Math.round((s.memoryRecallSuccesses / s.memoryRecalls) * 100) : 0,
      topEmojis: Object.entries(s.emojiUsages).sort(([,a],[,b]) => b-a).slice(0,10).map(([emoji,count]) => ({ emoji, count, followUps: s.emojiFollowUps[emoji] || 0 })),
      avgTurnsPerUser: Object.keys(s.userSessionTurns).length > 0 ? (Object.values(s.userSessionTurns).reduce((a,b) => a+b, 0) / Object.keys(s.userSessionTurns).length).toFixed(1) : 0,
      topUsers: Object.entries(s.userMessageCounts).sort(([,a],[,b]) => b-a).slice(0,20).map(([id,count]) => ({ id, count })),
      intentFunnel: { created: s.intentsCreated, surfaced: s.intentsSurfaced, resolved: s.intentsResolved },
      goalFunnel: { set: s.goalsSet, completed: s.goalsCompleted, abandoned: s.goalsAbandoned, avgLifespanMs: (s.goalsCompleted + s.goalsAbandoned) > 0 ? Math.round(s.totalGoalAgeMs / (s.goalsCompleted + s.goalsAbandoned)) : 0 },
      sentimentShifts: Object.values(s.sessionSentiments).reduce((acc: any, val) => { const shift = `${val.start} -> ${val.end}`; acc[shift] = (acc[shift] || 0) + 1; return acc; }, {}),
      conversationDropoffs: s.conversationDropoffs,
      topCommands: Object.entries(s.commandCounts).sort(([,a],[,b]) => b-a).map(([cmd,count]) => ({ cmd, count })),
      recentEvents: s.recentEvents.slice(-50).reverse(),
      coldOpens: s.coldOpens, coldOpenSuccesses: s.coldOpenSuccesses,
    };
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const batch_events = this.buffer.splice(0, this.batchSize);

    try {
      const rows = batch_events.map(e => ({
        event_type: e.eventType,
        timestamp: e.timestamp,
        hour: e.hour,
        day_of_week: e.dayOfWeek,
        user_id: e.userId ?? null,
        username: e.username ?? null,
        guild_id: e.guildId ?? null,
        channel_id: e.channelId ?? null,
        data: e.data,
      }));
      await notabotDb.from('telemetry_events').insert(rows);
    } catch (e) {
      console.error('[Telemetry] flush error:', e);
    }

    if (this.isLoaded) {
      try {
        const statsToSave = { ...this.stats } as any;
        statsToSave.uniqueUsers = Array.from(this.stats.uniqueUsers);
        statsToSave.uniqueGuilds = Array.from(this.stats.uniqueGuilds);
        delete statsToSave.recentEvents;
        await notabotDb.from('telemetry_global').upsert({ id: 'rollingStats', data: statsToSave }, { onConflict: 'id' });
      } catch (e) {
        console.error('[Telemetry] failed to save rolling stats:', e);
      }
    }
  }
}

export const Telemetry = new TelemetryEngine();
