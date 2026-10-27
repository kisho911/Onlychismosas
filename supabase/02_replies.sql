-- ════════════════════════════════════════════════════════════════════
--  OnlyChismosas — replies (group chat under each chisme)
--  Paste into Supabase → SQL Editor → New query → Run.  Run it once.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.replies (
  id            bigint generated always as identity primary key,
  chisme_id     bigint not null references public.chismes(id) on delete cascade,
  author_id     uuid references auth.users(id) on delete set null,
  author_name   text,
  body          text not null check (char_length(body) between 2 and 500),
  report_count  int not null default 0,
  hidden        boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists replies_thread_idx on public.replies (chisme_id, created_at);
create index if not exists replies_author_idx on public.replies (author_id, created_at desc);

create table if not exists public.reply_reports (
  reply_id     bigint not null references public.replies(id) on delete cascade,
  reporter_id  uuid   not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (reply_id, reporter_id)
);
create index if not exists reply_reports_reporter_idx on public.reply_reports (reporter_id, created_at desc);

alter table public.chismes add column if not exists reply_count int not null default 0;

alter table public.replies       enable row level security;
alter table public.reply_reports enable row level security;
revoke all on table public.replies, public.reply_reports from anon, authenticated;

-- ── Shared content check (same rules as posts) ──────────────────────

create or replace function public.assert_clean(b text)
returns void language plpgsql immutable as $$
begin
  if b ~* '(https?://|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ly|xyz|app|info|biz|link|site|shop)(\M|/))' then
    raise exception 'no_links';
  end if;
  if b ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
     or b ~* '(^|[^a-z0-9])@[a-z0-9_.]{3,}'
     or b ~ '(\d[ ().-]*){10,}'
     or b ~* '\m\d{1,6}\s+([a-z]+\s+){1,3}(st|street|ave|avenue|blvd|boulevard|road|rd|lane|ln|drive|dr|calle|avenida)\M'
  then
    raise exception 'no_contact_info';
  end if;
end $$;

create or replace function public.refresh_reply_count(p_chisme bigint)
returns void language sql security definer set search_path = public as $$
  update public.chismes
     set reply_count = (select count(*) from public.replies where chisme_id = p_chisme and not hidden)
   where id = p_chisme;
$$;

-- ── Feed now includes the reply count ───────────────────────────────

drop function if exists public.get_feed(text, text, int, int, boolean);
create function public.get_feed(
  p_sort text default 'hot',
  p_lang text default null,
  p_limit int default 20,
  p_offset int default 0,
  p_reported boolean default false
)
returns table (
  id bigint, body text, lang text, author_name text,
  hot_cups int, iced_cups int, score int, report_count int,
  hidden boolean, created_at timestamptz, is_mine boolean, my_vote smallint,
  reply_count int
)
language sql stable security definer set search_path = public as $$
  select c.id, c.body, c.lang, c.author_name,
         c.hot_cups, c.iced_cups, c.score,
         case when public.is_admin() then c.report_count else 0 end,
         c.hidden, c.created_at,
         coalesce(c.author_id = auth.uid(), false),
         v.value,
         c.reply_count
  from public.chismes c
  left join public.votes v on v.chisme_id = c.id and v.voter_id = auth.uid()
  where (not c.hidden or public.is_admin())
    and (p_lang is null or c.lang = p_lang)
    and (not p_reported or (public.is_admin() and (
          c.report_count > 0
          or exists (select 1 from public.replies r where r.chisme_id = c.id and r.report_count > 0))))
  order by
    case when p_sort = 'new' then c.created_at end desc nulls last,
    case when p_sort = 'top' then c.score end desc nulls last,
    case when p_sort = 'hot' then
      (c.score + c.reply_count / 2.0 + 1)::float / power(extract(epoch from (now() - c.created_at)) / 3600.0 + 2, 1.5)
    end desc nulls last,
    c.id desc
  limit least(greatest(p_limit, 1), 50)
  offset greatest(p_offset, 0);
$$;

-- ── Read a thread ───────────────────────────────────────────────────
-- who_n: 0 = the person who posted the chisme (OP),
--        1, 2, 3… = each other anonymous person, numbered in the order
--        they joined the thread (same number every time in this thread)

create or replace function public.get_replies(p_chisme bigint)
returns table (
  id bigint, body text, author_name text, who_n int,
  is_mine boolean, hidden boolean, report_count int, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with op as (
    select author_id from public.chismes where id = p_chisme and (not hidden or public.is_admin())
  ),
  r as (
    select rp.*, min(rp.created_at) over (partition by rp.author_id) as first_seen
    from public.replies rp
    where rp.chisme_id = p_chisme and exists (select 1 from op)
  ),
  people as (
    select author_id, dense_rank() over (order by first_seen, author_id) as n
    from (select distinct author_id, first_seen from r
          where author_id is distinct from (select author_id from op)) x
  )
  select r.id, r.body, r.author_name,
         case when r.author_id = (select author_id from op) then 0
              else coalesce((select n from people p where p.author_id = r.author_id), 1)::int end,
         coalesce(r.author_id = auth.uid(), false),
         r.hidden,
         case when public.is_admin() then r.report_count else 0 end,
         r.created_at
  from r
  where not r.hidden or public.is_admin()
  order by r.created_at, r.id
  limit 300;
$$;

-- ── Write a reply ───────────────────────────────────────────────────

create or replace function public.create_reply(p_chisme bigint, p_body text, p_show_name boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  b text := btrim(coalesce(p_body, ''));
  n int;
  new_id bigint;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select * into prof from public.profiles where id = uid;
  if coalesce(prof.banned, false) then raise exception 'banned'; end if;
  if not exists (select 1 from public.chismes where id = p_chisme and not hidden) then raise exception 'not_found'; end if;
  if char_length(b) < 2 or char_length(b) > 500 then raise exception 'bad_reply_length'; end if;
  perform public.assert_clean(b);

  select count(*) into n from public.replies where author_id = uid and created_at > now() - interval '5 minutes';
  if n >= 10 then raise exception 'slow_down'; end if;
  select count(*) into n from public.replies where author_id = uid and created_at > now() - interval '1 day';
  if n >= 150 then raise exception 'daily_limit'; end if;
  if exists (select 1 from public.replies where chisme_id = p_chisme and author_id = uid
               and lower(body) = lower(b) and created_at > now() - interval '1 day') then
    raise exception 'duplicate';
  end if;

  insert into public.replies (chisme_id, author_id, author_name, body)
  values (p_chisme, uid,
          case when coalesce(p_show_name, false) and not public.is_anonymous_user() then prof.username end,
          b)
  returning id into new_id;
  perform public.refresh_reply_count(p_chisme);
  return new_id;
end $$;

-- ── Report / delete / moderate replies ──────────────────────────────
-- 3 reports hide a reply until an admin reviews it.

create or replace function public.report_reply(p_reply bigint)
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int; cnt int; cid bigint;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select count(*) into n from public.reply_reports where reporter_id = uid and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'slow_down'; end if;
  insert into public.reply_reports (reply_id, reporter_id) values (p_reply, uid) on conflict do nothing;
  select count(*) into cnt from public.reply_reports where reply_id = p_reply;
  update public.replies set report_count = cnt, hidden = hidden or cnt >= 3
   where id = p_reply returning chisme_id into cid;
  if cid is not null then perform public.refresh_reply_count(cid); end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.delete_reply(p_reply bigint)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from public.replies
   where id = p_reply and (author_id = auth.uid() or public.is_admin())
   returning chisme_id into cid;
  if cid is null then raise exception 'not_allowed'; end if;
  perform public.refresh_reply_count(cid);
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_set_reply_hidden(p_reply bigint, p_hidden boolean)
returns json language plpgsql security definer set search_path = public as $$
declare cid bigint;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  update public.replies
     set hidden = p_hidden, report_count = case when p_hidden then report_count else 0 end
   where id = p_reply returning chisme_id into cid;
  if not p_hidden then delete from public.reply_reports where reply_id = p_reply; end if;
  if cid is not null then perform public.refresh_reply_count(cid); end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_ban_reply_author(p_reply bigint)
returns json language plpgsql security definer set search_path = public as $$
declare a uuid; c bigint;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  select author_id into a from public.replies where id = p_reply;
  if a is null then raise exception 'not_found'; end if;
  update public.profiles set banned = true where id = a and not is_admin;
  update public.chismes set hidden = true where author_id = a;
  update public.replies set hidden = true where author_id = a;
  for c in select distinct chisme_id from public.replies where author_id = a loop
    perform public.refresh_reply_count(c);
  end loop;
  return json_build_object('ok', true);
end $$;

-- Banning from a post also hides that person's replies everywhere
create or replace function public.admin_ban_author(p_chisme bigint)
returns json language plpgsql security definer set search_path = public as $$
declare a uuid; c bigint;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  select author_id into a from public.chismes where id = p_chisme;
  if a is null then raise exception 'not_found'; end if;
  update public.profiles set banned = true where id = a and not is_admin;
  update public.chismes set hidden = true where author_id = a;
  update public.replies set hidden = true where author_id = a;
  for c in select distinct chisme_id from public.replies where author_id = a loop
    perform public.refresh_reply_count(c);
  end loop;
  return json_build_object('ok', true);
end $$;

-- ── Permissions ─────────────────────────────────────────────────────

revoke execute on function public.assert_clean(text)           from public, anon, authenticated;
revoke execute on function public.refresh_reply_count(bigint)  from public, anon, authenticated;
revoke execute on function public.get_feed(text, text, int, int, boolean) from public;
revoke execute on function public.get_replies(bigint)          from public;
revoke execute on function public.create_reply(bigint, text, boolean) from public, anon;
revoke execute on function public.report_reply(bigint)         from public, anon;
revoke execute on function public.delete_reply(bigint)         from public, anon;
revoke execute on function public.admin_set_reply_hidden(bigint, boolean) from public, anon;
revoke execute on function public.admin_ban_reply_author(bigint) from public, anon;
revoke execute on function public.admin_ban_author(bigint)     from public, anon;

grant execute on function public.get_feed(text, text, int, int, boolean) to anon, authenticated;
grant execute on function public.get_replies(bigint)           to anon, authenticated;
grant execute on function public.create_reply(bigint, text, boolean) to authenticated;
grant execute on function public.report_reply(bigint)          to authenticated;
grant execute on function public.delete_reply(bigint)          to authenticated;
grant execute on function public.admin_set_reply_hidden(bigint, boolean) to authenticated;
grant execute on function public.admin_ban_reply_author(bigint) to authenticated;
grant execute on function public.admin_ban_author(bigint)      to authenticated;
