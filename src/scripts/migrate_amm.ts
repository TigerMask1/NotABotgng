import { businessBotDb as db } from '../services/supabase.ts';

async function run() {
  console.log('Fetching global state for current stock prices...');
  const { data: globalState, error: gErr } = await db.from('business_global').select('stock_prices').eq('id', 'state').single();
  if (gErr) { console.error("Global state error:", gErr); return; }
  
  const stockPrices = (globalState?.stock_prices || {}) as Record<string, number>;
  console.log('Current stock prices:', stockPrices);

  console.log('Fetching users with stocks...');
  // Only users who have non-empty stocks object
  const { data: users, error: uErr } = await db.from('business_users').select('user_id, username, botcoin, stocks');
  if (uErr) { console.error("Users error:", uErr); return; }

  let count = 0;
  for (const user of users || []) {
    const stocks = user.stocks as Record<string, number> | null;
    if (!stocks || Object.keys(stocks).length === 0) continue;

    let refund = 0;
    for (const [sym, shares] of Object.entries(stocks)) {
      if (shares <= 0) continue;
      const price = stockPrices[sym] || 100;
      refund += price * shares;
    }

    if (refund > 0) {
      const newBotcoin = (user.botcoin || 0) + refund;
      console.log(`Refunding ${user.username}: ${refund} Botcoins for legacy stocks.`);
      await db.from('business_users').update({ botcoin: newBotcoin, stocks: {} }).eq('user_id', user.user_id);
      count++;
    }
  }
  
  console.log(`Successfully refunded ${count} users. Stocks are now wiped.`);
}

run();
