import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createClient } from '@supabase/supabase-js';

// Use SERVICE ROLE keys to bypass RLS during migration
function getMigrationClients() {
  const notabotUrl = process.env.NOTABOT_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const notabotServiceKey = process.env.NOTABOT_SUPABASE_SERVICE_KEY || process.env.NOTABOT_SUPABASE_KEY || '';
  const businessUrl = process.env.BUSINESSBOT_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const businessServiceKey = process.env.BUSINESSBOT_SUPABASE_SERVICE_KEY || process.env.BUSINESSBOT_SUPABASE_KEY || '';

  const notabotDb = createClient(notabotUrl, notabotServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const businessBotDb = createClient(businessUrl, businessServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return { notabotDb, businessBotDb };
}


export async function runFirebaseMigration() {
  console.log("🚀 [Migration] Starting migration from Firebase to Supabase...");

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.error("❌ [Migration] Missing FIREBASE env vars. Cannot run migration.");
    return;
  }

  // Prevent multiple initializations if the server hot-reloads
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }
  
  const db = getFirestore();

  try {
    const { notabotDb, businessBotDb } = getMigrationClients();

    // --- MIGRATE BUSINESS BOT USERS ---
    console.log("📦 [Migration] Migrating BusinessBot users...");
    const bUsersSnap = await db.collection('businessUsers').get();
    const bUsersBatch = bUsersSnap.docs.map(doc => {
      const data = doc.data();
      return {
        user_id: doc.id,
        username: data.username,
        custom_name: data.customName,
        botcoin: data.botcoin || 0,
        net_worth: data.netWorth || 0,
        granted: data.granted || false,
        inventory: data.inventory || {},
        last_daily: data.lastDaily || 0,
        daily_streak: data.dailyStreak || 0,
        last_rob: data.lastRob || 0,
        jail_until: data.jailUntil || 0,
        stocks: data.stocks || {},
        total_earned: data.totalEarned || 0,
        total_gambled: data.totalGambled || 0,
        wins: data.wins || 0,
        losses: data.losses || 0,
        xp: data.xp || 0,
        level: data.level || 1
      };
    });
    
    if (bUsersBatch.length > 0) {
      const { error } = await businessBotDb.from('business_users').upsert(bUsersBatch);
      if (error) console.error("[Migration] Error migrating business users:", error);
      else console.log(`✅ [Migration] Migrated ${bUsersBatch.length} BusinessBot users.`);
    }

    // --- MIGRATE SERVERS ---
    console.log("📦 [Migration] Migrating Servers and Members...");
    const serversSnap = await db.collection('servers').get();
    
    const serversBatch: any[] = [];
    const membersBatch: any[] = [];
    const xpBatch: any[] = [];

    for (const doc of serversSnap.docs) {
      const guildId = doc.id;
      const data = doc.data();
      serversBatch.push({
        guild_id: guildId,
        name: data.name || guildId,
        bot_muted: data.botMuted || false,
        allowed_bot_ids: data.allowedBotIds || [],
        allowed_channel_ids: data.allowedChannelIds || []
      });

      // Subcollection: Members
      const membersSnap = await db.collection('servers').doc(guildId).collection('members').get();
      membersSnap.docs.forEach(mDoc => {
        const mData = mDoc.data();
        membersBatch.push({
          guild_id: guildId,
          user_id: mDoc.id,
          username: mData.username,
          display_name: mData.displayName,
          personality: mData.personality,
          bond: mData.bond || 50,
          seen_count: mData.seenCount || 0,
          last_seen_at: mData.lastSeenAt,
          about: mData.about
        });
      });

      // Subcollection: XP
      const xpSnap = await db.collection('servers').doc(guildId).collection('xp').get();
      xpSnap.docs.forEach(xDoc => {
        const xData = xDoc.data();
        xpBatch.push({
          guild_id: guildId,
          user_id: xDoc.id,
          username: xData.username,
          xp: xData.xp || 0,
          level: xData.level || 1
        });
      });
    }

    if (serversBatch.length > 0) {
      const { error } = await notabotDb.from('servers').upsert(serversBatch);
      if (error) console.error("[Migration] Error migrating servers:", error);
      else console.log(`✅ [Migration] Migrated ${serversBatch.length} Servers.`);
    }

    if (membersBatch.length > 0) {
      const { error } = await notabotDb.from('server_members').upsert(membersBatch);
      if (error) console.error("[Migration] Error migrating members:", error);
      else console.log(`✅ [Migration] Migrated ${membersBatch.length} Server Members.`);
    }

    if (xpBatch.length > 0) {
      const { error } = await notabotDb.from('server_xp').upsert(xpBatch);
      if (error) console.error("[Migration] Error migrating xp:", error);
      else console.log(`✅ [Migration] Migrated ${xpBatch.length} XP records.`);
    }

    console.log("🎉 [Migration] Transfer Complete!");
  } catch (error) {
    console.error("❌ [Migration] Encountered a fatal error during migration:", error);
  }
}
