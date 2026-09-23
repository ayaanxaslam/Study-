-- ============================================================
-- RewardTutor — Supabase setup
-- Paste this whole file into: Supabase dashboard -> SQL Editor -> New query -> Run
-- Safe to run more than once.
-- ============================================================

-- One row per user holding this month's question count.
create table if not exists public.question_usage (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  month      text        not null,
  used       integer     not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.question_usage enable row level security;

-- Each person can only ever see or change their own row.
drop policy if exists "read own usage"   on public.question_usage;
drop policy if exists "insert own usage" on public.question_usage;
drop policy if exists "update own usage" on public.question_usage;

create policy "read own usage" on public.question_usage
  for select using (auth.uid() = user_id);

create policy "insert own usage" on public.question_usage
  for insert with check (auth.uid() = user_id);

create policy "update own usage" on public.question_usage
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Atomic increment that also handles the monthly rollover.
-- Returns the new count for the caller's own row.
create or replace function public.increment_question_usage(p_month text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  insert into public.question_usage as qu (user_id, month, used)
  values (auth.uid(), p_month, 1)
  on conflict (user_id) do update
    set used       = case when qu.month = p_month then qu.used + 1 else 1 end,
        month      = p_month,
        updated_at = now()
  returning qu.used into v_used;

  return v_used;
end;
$$;

grant execute on function public.increment_question_usage(text) to authenticated;


-- ============================================================
-- Chat sessions — one row per conversation, owned by one user
-- ============================================================

create table if not exists public.chat_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  title      text        not null default 'New session',
  messages   jsonb       not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_sessions_user_updated
  on public.chat_sessions (user_id, updated_at desc);

alter table public.chat_sessions enable row level security;

drop policy if exists "read own sessions"   on public.chat_sessions;
drop policy if exists "insert own sessions" on public.chat_sessions;
drop policy if exists "update own sessions" on public.chat_sessions;
drop policy if exists "delete own sessions" on public.chat_sessions;

create policy "read own sessions" on public.chat_sessions
  for select using (auth.uid() = user_id);

create policy "insert own sessions" on public.chat_sessions
  for insert with check (auth.uid() = user_id);

create policy "update own sessions" on public.chat_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own sessions" on public.chat_sessions
  for delete using (auth.uid() = user_id);


-- ============================================================
-- Plans — which account has paid. Only the Stripe webhook writes
-- here (via the service role key); users may read their own row.
-- ============================================================

create table if not exists public.profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  plan                   text        not null default 'free',
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;

-- Deliberately read-only for users: nobody can promote themselves to Plus.
create policy "read own profile" on public.profiles
  for select using (auth.uid() = user_id);

-- Everyone who signs up starts on the free plan.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, plan)
  values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this table existed.
insert into public.profiles (user_id, plan)
select id, 'free' from auth.users
on conflict (user_id) do nothing;


-- ============================================================
-- Hardened counter: the month comes from the database clock, not
-- from the browser, so changing a device clock cannot reset it.
-- Run this after the earlier sections; it replaces the function.
-- ============================================================

create or replace function public.increment_question_usage(p_month text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used  integer;
  v_month text := to_char(now() at time zone 'utc', 'YYYY-FMMM');
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  insert into public.question_usage as qu (user_id, month, used)
  values (auth.uid(), v_month, 1)
  on conflict (user_id) do update
    set used       = case when qu.month = v_month then qu.used + 1 else 1 end,
        month      = v_month,
        updated_at = now()
  returning qu.used into v_used;

  return v_used;
end;
$$;

grant execute on function public.increment_question_usage(text) to authenticated;

-- Reports the caller's count for the current month, resetting the view
-- automatically once the month rolls over.
create or replace function public.current_question_usage()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used  integer;
  v_month text := to_char(now() at time zone 'utc', 'YYYY-FMMM');
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select case when month = v_month then used else 0 end
    into v_used
    from public.question_usage
   where user_id = auth.uid();

  return coalesce(v_used, 0);
end;
$$;

grant execute on function public.current_question_usage() to authenticated;


-- ============================================================
-- Rate limiting. One row per bucket, where a bucket is either a
-- hashed IP address or a user id. Only the server (service role)
-- touches this table, so there are no policies for users.
-- ============================================================

create table if not exists public.rate_limits (
  bucket       text primary key,
  window_start timestamptz not null default now(),
  count        integer     not null default 0
);

alter table public.rate_limits enable row level security;
-- No policies on purpose: with RLS on and nothing granted, signed-in users
-- cannot read or write this table at all.

create or replace function public.bump_rate_limit(p_bucket text, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits as rl (bucket, window_start, count)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update
    set count = case
          when rl.window_start > now() - make_interval(secs => p_window_seconds)
          then rl.count + 1
          else 1
        end,
        window_start = case
          when rl.window_start > now() - make_interval(secs => p_window_seconds)
          then rl.window_start
          else now()
        end
  returning rl.count into v_count;

  return v_count;
end;
$$;

-- Housekeeping: drop buckets nobody has touched for a day.
create or replace function public.prune_rate_limits()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;
