-- ═══════════════════════════════════════════════════════════════════════════
-- SUPABASE SCHEMA — Run this in the SQL Editor of the relevant project.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── HOW TO USE ──────────────────────────────────────────────────────────────
-- 1. Go to https://supabase.com and open your PROJECT for NotABot.
-- 2. Click "SQL Editor" in the left sidebar.
-- 3. Paste and run everything under the "NOTABOT PROJECT" section.
-- 4. Open your PROJECT for BusinessBot and repeat with the "BUSINESSBOT PROJECT" section.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- NOTABOT PROJECT — paste into your NotABot Supabase project
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists servers (
  guild_id            text primary key,
  name                text,
  bot_muted           boolean default false,
  allowed_bot_ids     text[] default '{}',
  allowed_channel_ids text[] default '{}',
  updated_at          timestamptz default now()
);

create table if not exists server_channels (
  guild_id    text not null,
  channel_id  text not null,
  name        text,
  updated_at  timestamptz default now(),
  primary key (guild_id, channel_id)
);

create table if not exists server_members (
  guild_id     text not null,
  user_id      text not null,
  username     text,
  display_name text,
  personality  text,
  bond         integer default 50,
  seen_count   integer default 0,
  last_seen_at timestamptz,
  about        text,
  primary key (guild_id, user_id)
);

create table if not exists server_xp (
  guild_id    text not null,
  user_id     text not null,
  username    text,
  xp          integer default 0,
  level       integer default 1,
  updated_at  timestamptz default now(),
  primary key (guild_id, user_id)
);

create table if not exists intents (
  id         text primary key,
  guild_id   text not null,
  status     text default 'pending',
  what       text,
  trigger_user_id text,
  trigger_type    text,
  trigger_keyword text,
  created_at timestamptz default now()
);
create index if not exists idx_intents_guild_status on intents(guild_id, status);

create table if not exists memory_store (
  key        text primary key,
  entries    jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists history_logs (
  id          bigserial primary key,
  channel_id  text not null,
  guild_id    text,
  summary     text,
  from_ts     bigint,
  to_ts       bigint,
  created_at  timestamptz default now()
);
create index if not exists idx_history_channel on history_logs(channel_id, to_ts desc);

create table if not exists youtube_queue (
  id          bigserial primary key,
  guild_id    text,
  guild_name  text,
  channel_id  text not null,
  channel_name text,
  messages    jsonb not null,
  media_summary jsonb default '[]'::jsonb,
  clip_mode   text default 'normal',
  status      text default 'pending',
  queued_at   bigint not null,
  processed_at timestamptz
);
create index if not exists idx_youtube_queue_status on youtube_queue(status, queued_at asc);

create table if not exists telemetry_events (
  id          bigserial primary key,
  event_type  text not null,
  timestamp   timestamptz not null,
  hour        smallint,
  day_of_week smallint,
  user_id     text,
  username    text,
  guild_id    text,
  channel_id  text,
  data        jsonb default '{}'::jsonb
);
create index if not exists idx_telemetry_ts on telemetry_events(timestamp desc);

create table if not exists telemetry_global (
  id   text primary key default 'rollingStats',
  data jsonb default '{}'::jsonb
);

create table if not exists telemetry_history (
  date_str text not null,
  hour_str text not null,
  data     jsonb default '{}'::jsonb,
  primary key (date_str, hour_str)
);

create table if not exists dm_relationships (
  user_id                    text primary key,
  total_dm_turns             integer default 0,
  last_dm_at                 bigint default 0,
  last_bot_message_at        bigint default 0,
  last_bot_message_text      text default '',
  got_reply_to_last          boolean default false,
  playbook_channel           bigint,
  playbook_businessbot       bigint,
  playbook_server_invite     bigint,
  playbook_latest_video      bigint,
  updated_at                 timestamptz default now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- BUSINESSBOT PROJECT — paste into your BusinessBot Supabase project
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists business_global (
  id               text primary key default 'state',
  stock_prices     jsonb default '{}'::jsonb,
  custom_items     jsonb default '{}'::jsonb,
  bounties         jsonb default '{}'::jsonb,
  auctions         jsonb default '{}'::jsonb,
  trades           jsonb default '{}'::jsonb,
  shop             jsonb default '{}'::jsonb,
  active_challenges jsonb default '{}'::jsonb,
  updated_at       timestamptz default now()
);
-- Seed the global state row so it always exists
insert into business_global (id) values ('state') on conflict do nothing;

create table if not exists business_users (
  user_id       text primary key,
  username      text,
  custom_name   text,
  botcoin       bigint default 0,
  net_worth     bigint default 0,
  granted       boolean default false,
  inventory     jsonb default '{}'::jsonb,
  last_daily    bigint default 0,
  daily_streak  integer default 0,
  last_rob      bigint default 0,
  jail_until    bigint default 0,
  stocks        jsonb default '{}'::jsonb,
  total_earned  bigint default 0,
  total_gambled bigint default 0,
  wins          integer default 0,
  losses        integer default 0,
  xp            integer default 0,
  level         integer default 1,
  updated_at    timestamptz default now()
);
create index if not exists idx_business_users_networth on business_users(net_worth desc);
