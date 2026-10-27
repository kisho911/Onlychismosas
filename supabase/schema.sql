-- ════════════════════════════════════════════════════════════════════
--  OnlyChismosas — database setup
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  Safe to run once on a fresh project.
-- ════════════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  is_admin    boolean not null default false,
  banned      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.chismes (
  id            bigint generated always as identity primary key,
  author_id     uuid references auth.users(id) on delete set null,
  author_name   text,                       -- only set when the author chose to show their username
  body          text not null check (char_length(body) between 10 and 1000),
  lang          text not null check (lang in ('en','es')),
  hot_cups      int not null default 0,     -- ☕ up votes
  iced_cups     int not null default 0,     -- 🧊 down votes
  score         int not null default 0,
  report_count  int not null default 0,
  hidden        boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists chismes_created_idx on public.chismes (created_at desc);
create index if not exists chismes_score_idx   on public.chismes (score desc);
create index if not exists chismes_author_idx  on public.chismes (author_id, created_at desc);

create table if not exists public.votes (
  chisme_id   bigint not null references public.chismes(id) on delete cascade,
  voter_id    uuid   not null references auth.users(id) on delete cascade,
  value       smallint not null check (value in (-1, 1)),
  created_at  timestamptz not null default now(),
  primary key (chisme_id, voter_id)
);
create index if not exists votes_voter_idx on public.votes (voter_id, created_at desc);

create table if not exists public.reports (
  chisme_id    bigint not null references public.chismes(id) on delete cascade,
  reporter_id  uuid   not null references auth.users(id) on delete cascade,
  reason       text check (char_length(reason) <= 200),
  created_at   timestamptz not null default now(),
  primary key (chisme_id, reporter_id)
);
create index if not exists reports_reporter_idx on public.reports (reporter_id, created_at desc);

-- ── Lock the tables down ────────────────────────────────────────────
-- Visitors never touch tables directly. Everything goes through the
-- functions below, which do their own checks. This also keeps who
-- wrote an anonymous post private.

alter table public.profiles enable row level security;
alter table public.chismes  enable row level security;
alter table public.votes    enable row level security;
alter table public.reports  enable row level security;

revoke all on table public.profiles, public.chismes, public.votes, public.reports from anon, authenticated;

-- ── Every new login (anonymous or account) gets a profile row ──────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Helpers ─────────────────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_anonymous_user()
returns boolean language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- ── Who am I ────────────────────────────────────────────────────────

create or replace function public.get_me()
returns json language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null then
    return json_build_object('signed_in', false);
  end if;
  select * into p from public.profiles where id = auth.uid();
  return json_build_object(
    'signed_in',    true,
    'is_anonymous', public.is_anonymous_user(),
    'username',     p.username,
    'is_admin',     coalesce(p.is_admin, false),
    'banned',       coalesce(p.banned, false)
  );
end $$;

create or replace function public.set_username(p_username text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if public.is_anonymous_user() then raise exception 'account_required'; end if;
  if p_username !~ '^[A-Za-z0-9_]{3,20}$' then raise exception 'bad_username'; end if;
  begin
    insert into public.profiles (id, username) values (auth.uid(), p_username)
    on conflict (id) do update set username = excluded.username;
  exception when unique_violation then
    raise exception 'username_taken';
  end;
  return public.get_me();
end $$;

-- ── Feed ────────────────────────────────────────────────────────────
-- p_sort: 'hot' | 'new' | 'top'   p_lang: 'en' | 'es' | null (all)
-- p_reported: admins only — show reported posts (including hidden ones)

create or replace function public.get_feed(
  p_sort text default 'hot',
  p_lang text default null,
  p_limit int default 20,
  p_offset int default 0,
  p_reported boolean default false
)
returns table (
  id bigint, body text, lang text, author_name text,
  hot_cups int, iced_cups int, score int, report_count int,
  hidden boolean, created_at timestamptz, is_mine boolean, my_vote smallint
)
language sql stable security definer set search_path = public as $$
  select c.id, c.body, c.lang, c.author_name,
         c.hot_cups, c.iced_cups, c.score,
         case when public.is_admin() then c.report_count else 0 end,
         c.hidden, c.created_at,
         coalesce(c.author_id = auth.uid(), false),
         v.value
  from public.chismes c
  left join public.votes v on v.chisme_id = c.id and v.voter_id = auth.uid()
  where (not c.hidden or public.is_admin())
    and (p_lang is null or c.lang = p_lang)
    and (not p_reported or (public.is_admin() and c.report_count > 0))
  order by
    case when p_sort = 'new' then c.created_at end desc nulls last,
    case when p_sort = 'top' then c.score end desc nulls last,
    case when p_sort = 'hot' then
      (c.score + 1)::float / power(extract(epoch from (now() - c.created_at)) / 3600.0 + 2, 1.5)
    end desc nulls last,
    c.id desc
  limit least(greatest(p_limit, 1), 50)
  offset greatest(p_offset, 0);
$$;

-- ── Post a chisme ───────────────────────────────────────────────────

create or replace function public.create_chisme(p_body text, p_lang text, p_show_name boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  b text := btrim(coalesce(p_body, ''));
  n_recent int;
  n_today int;
  new_id bigint;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select * into prof from public.profiles where id = uid;
  if coalesce(prof.banned, false) then raise exception 'banned'; end if;

  if char_length(b) < 10 or char_length(b) > 1000 then raise exception 'bad_length'; end if;
  if p_lang is null or p_lang not in ('en', 'es') then raise exception 'bad_lang'; end if;

  -- No links (spam) …
  if b ~* '(https?://|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ly|xyz|app|info|biz|link|site|shop)(\M|/))' then
    raise exception 'no_links';
  end if;
  -- … and no contact info / doxxing: emails, @handles, phone numbers, street addresses
  if b ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
     or b ~* '(^|[^a-z0-9])@[a-z0-9_.]{3,}'
     or b ~ '(\d[ ().-]*){10,}'
     or b ~* '\m\d{1,6}\s+([a-z]+\s+){1,3}(st|street|ave|avenue|blvd|boulevard|road|rd|lane|ln|drive|dr|calle|avenida)\M'
  then
    raise exception 'no_contact_info';
  end if;

  -- Rate limits: 3 posts per 10 minutes, 15 per day
  select count(*) into n_recent from public.chismes
   where author_id = uid and created_at > now() - interval '10 minutes';
  if n_recent >= 3 then raise exception 'slow_down'; end if;
  select count(*) into n_today from public.chismes
   where author_id = uid and created_at > now() - interval '1 day';
  if n_today >= 15 then raise exception 'daily_limit'; end if;

  -- Copy-paste spam
  if exists (select 1 from public.chismes
              where lower(body) = lower(b) and created_at > now() - interval '7 days') then
    raise exception 'duplicate';
  end if;

  insert into public.chismes (author_id, author_name, body, lang)
  values (
    uid,
    case when coalesce(p_show_name, false) and not public.is_anonymous_user() then prof.username end,
    b,
    p_lang
  )
  returning id into new_id;
  return new_id;
end $$;

-- ── Tea cups (votes) ────────────────────────────────────────────────
-- p_value: 1 = ☕ hot tea, -1 = 🧊 iced tea, 0 = remove my vote

create or replace function public.cast_vote(p_chisme bigint, p_value int)
returns json language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int;
  h int;
  i int;
  mine smallint;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  if p_value not in (-1, 0, 1) then raise exception 'bad_vote'; end if;
  if exists (select 1 from public.profiles where id = uid and banned) then raise exception 'banned'; end if;
  if not exists (select 1 from public.chismes where id = p_chisme and not hidden) then raise exception 'not_found'; end if;

  select count(*) into n from public.votes where voter_id = uid and created_at > now() - interval '1 minute';
  if n >= 40 then raise exception 'slow_down'; end if;

  if p_value = 0 then
    delete from public.votes where chisme_id = p_chisme and voter_id = uid;
  else
    insert into public.votes (chisme_id, voter_id, value) values (p_chisme, uid, p_value)
    on conflict (chisme_id, voter_id) do update set value = excluded.value, created_at = now();
  end if;

  select count(*) filter (where value = 1), count(*) filter (where value = -1)
    into h, i from public.votes where chisme_id = p_chisme;
  update public.chismes set hot_cups = h, iced_cups = i, score = h - i where id = p_chisme;

  select value into mine from public.votes where chisme_id = p_chisme and voter_id = uid;
  return json_build_object('hot_cups', h, 'iced_cups', i, 'score', h - i, 'my_vote', mine);
end $$;

-- ── Reports ─────────────────────────────────────────────────────────
-- 5 reports from different people hides a post until an admin reviews it.

create or replace function public.report_chisme(p_chisme bigint, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int;
  cnt int;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select count(*) into n from public.reports where reporter_id = uid and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'slow_down'; end if;

  insert into public.reports (chisme_id, reporter_id, reason)
  values (p_chisme, uid, left(p_reason, 200))
  on conflict do nothing;

  select count(*) into cnt from public.reports where chisme_id = p_chisme;
  update public.chismes
     set report_count = cnt,
         hidden = hidden or cnt >= 5
   where id = p_chisme;
  return json_build_object('ok', true);
end $$;

-- ── Delete (your own post, or any post if you're admin) ─────────────

create or replace function public.delete_chisme(p_chisme bigint)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from public.chismes
   where id = p_chisme and (author_id = auth.uid() or public.is_admin());
  if not found then raise exception 'not_allowed'; end if;
  return json_build_object('ok', true);
end $$;

-- ── Admin tools ─────────────────────────────────────────────────────

create or replace function public.admin_set_hidden(p_chisme bigint, p_hidden boolean)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  update public.chismes
     set hidden = p_hidden,
         report_count = case when p_hidden then report_count else 0 end
   where id = p_chisme;
  if not p_hidden then delete from public.reports where chisme_id = p_chisme; end if;
  return json_build_object('ok', true);
end $$;

-- Bans whoever wrote this post (without ever showing you who they are)
-- and hides everything they've posted.
create or replace function public.admin_ban_author(p_chisme bigint)
returns json language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  select author_id into a from public.chismes where id = p_chisme;
  if a is null then raise exception 'not_found'; end if;
  update public.profiles set banned = true where id = a and not is_admin;
  update public.chismes set hidden = true where author_id = a;
  return json_build_object('ok', true);
end $$;

-- ── Who may call what ───────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_feed(text, text, int, int, boolean)  to anon, authenticated;
grant execute on function public.get_me()                                 to anon, authenticated;
grant execute on function public.is_admin()                               to anon, authenticated;
grant execute on function public.is_anonymous_user()                      to anon, authenticated;
grant execute on function public.set_username(text)                       to authenticated;
grant execute on function public.create_chisme(text, text, boolean)       to authenticated;
grant execute on function public.cast_vote(bigint, int)                   to authenticated;
grant execute on function public.report_chisme(bigint, text)              to authenticated;
grant execute on function public.delete_chisme(bigint)                    to authenticated;
grant execute on function public.admin_set_hidden(bigint, boolean)        to authenticated;
grant execute on function public.admin_ban_author(bigint)                 to authenticated;

-- ════════════════════════════════════════════════════════════════════
--  After you create YOUR account on the site, run this once (with your
--  email) to make yourself the admin:
--
--    update public.profiles set is_admin = true
--    where id = (select id from auth.users where email = 'you@example.com');
-- ════════════════════════════════════════════════════════════════════
