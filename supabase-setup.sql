-- ============================================================
-- Study Piolet — Supabase setup
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
