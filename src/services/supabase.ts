import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

// ── NotABot Database ───────────────────────────────────────────────────────────
const notabotUrl = process.env.NOTABOT_SUPABASE_URL || process.env.SUPABASE_URL || '';
const notabotKey = process.env.NOTABOT_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

if (!notabotUrl || !notabotKey) {
  console.warn('[Supabase] NOTABOT_SUPABASE_URL or KEY missing. Features will fail until configured.');
}

export const notabotDb = createClient(
  notabotUrl || 'https://placeholder.supabase.co',
  notabotKey || 'placeholder-key',
  { auth: { persistSession: false } }
);

// ── BusinessBot Database ───────────────────────────────────────────────────────
const businessUrl = process.env.BUSINESSBOT_SUPABASE_URL || process.env.SUPABASE_URL || '';
const businessKey = process.env.BUSINESSBOT_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

if (!businessUrl || !businessKey) {
  console.warn('[Supabase] BUSINESSBOT_SUPABASE_URL or KEY missing. Features will fail until configured.');
}

export const businessBotDb = createClient(
  businessUrl || 'https://placeholder.supabase.co',
  businessKey || 'placeholder-key',
  { auth: { persistSession: false } }
);
