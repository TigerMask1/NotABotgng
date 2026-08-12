import { createClient } from '@supabase/supabase-js';

// ── NotABot Database ───────────────────────────────────────────────────────────
const notabotUrl = process.env.NOTABOT_SUPABASE_URL;
const notabotKey = process.env.NOTABOT_SUPABASE_KEY;

if (!notabotUrl || !notabotKey) {
  console.warn('[Supabase] NOTABOT_SUPABASE_URL or NOTABOT_SUPABASE_KEY missing. NotABot DB features may not work.');
}

export const notabotDb = createClient(
  notabotUrl ?? '',
  notabotKey ?? '',
  { auth: { persistSession: false } }
);

// ── BusinessBot Database ───────────────────────────────────────────────────────
const businessUrl = process.env.BUSINESSBOT_SUPABASE_URL;
const businessKey = process.env.BUSINESSBOT_SUPABASE_KEY;

if (!businessUrl || !businessKey) {
  console.warn('[Supabase] BUSINESSBOT_SUPABASE_URL or BUSINESSBOT_SUPABASE_KEY missing. BusinessBot DB features may not work.');
}

export const businessBotDb = createClient(
  businessUrl ?? '',
  businessKey ?? '',
  { auth: { persistSession: false } }
);
