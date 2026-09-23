import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'ytautomation/.env' });
const db = createClient(process.env.NOTABOT_SUPABASE_URL, process.env.NOTABOT_SUPABASE_SERVICE_KEY);
async function run() {
    const res = await db.from('server_members').upsert({ guild_id: 'global', user_id: 'test' });
    console.log(res.error ? res.error : 'Success!');
    process.exit(0);
}
run();
