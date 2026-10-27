-- ════════════════════════════════════════════════════════════════════
--  OnlyChismosas — topic tags, direct links, Chisme del día
--  Paste into Supabase → SQL Editor → New query → Run.  Run it once.
-- ════════════════════════════════════════════════════════════════════

alter table public.chismes add column if not exists tag text
  check (tag is null or tag in ('amor', 'trabajo', 'familia', 'vecinos', 'amigas', 'random'));
create index if not exists chismes_tag_idx on public.chismes (tag, created_at desc);

-- ── Feed: now also filters by tag, fetches one post by id, and
--    p_sort = 'today' returns the hottest chisme of the last 24 hours ──

drop function if exists public.get_feed(text, text, int, int, boolean);
drop function if exists public.get_feed(text, text, int, int, boolean, text, bigint);
create function public.get_feed(
  p_sort text default 'hot',
  p_lang text default null,
  p_limit int default 20,
  p_offset int default 0,
  p_reported boolean default false,
  p_tag text default null,
  p_id bigint default null
)
returns table (
  id bigint, body text, lang text, author_name text,
  hot_cups int, iced_cups int, score int, report_count int,
  hidden boolean, created_at timestamptz, is_mine boolean, my_vote smallint,
  reply_count int, tag text
)
language sql stable security definer set search_path = public as $$
  select c.id, c.body, c.lang, c.author_name,
         c.hot_cups, c.iced_cups, c.score,
         case when public.is_admin() then c.report_count else 0 end,
         c.hidden, c.created_at,
         coalesce(c.author_id = auth.uid(), false),
         v.value,
         c.reply_count,
         c.tag
  from public.chismes c
  left join public.votes v on v.chisme_id = c.id and v.voter_id = auth.uid()
  where (not c.hidden or public.is_admin())
    and (p_id is null or c.id = p_id)
    and (p_lang is null or c.lang = p_lang)
    and (p_tag is null or c.tag = p_tag)
    and (p_sort <> 'today' or (c.created_at > now() - interval '1 day' and not c.hidden
                               and (c.score + c.reply_count) >= 3))
    and (not p_reported or (public.is_admin() and (
          c.report_count > 0
          or exists (select 1 from public.replies r where r.chisme_id = c.id and r.report_count > 0))))
  order by
    case when p_sort = 'new' then c.created_at end desc nulls last,
    case when p_sort = 'top' then c.score end desc nulls last,
    case when p_sort = 'today' then c.score * 2 + c.reply_count end desc nulls last,
    case when p_sort = 'hot' then
      (c.score + c.reply_count / 2.0 + 1)::float / power(extract(epoch from (now() - c.created_at)) / 3600.0 + 2, 1.5)
    end desc nulls last,
    c.id desc
  limit least(greatest(p_limit, 1), 50)
  offset greatest(p_offset, 0);
$$;

-- ── Posting now takes an optional tag ───────────────────────────────

drop function if exists public.create_chisme(text, text, boolean);
create or replace function public.create_chisme(p_body text, p_lang text, p_show_name boolean default false, p_tag text default null)
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
  if p_tag is not null and p_tag not in ('amor', 'trabajo', 'familia', 'vecinos', 'amigas', 'random') then
    raise exception 'bad_tag';
  end if;
  perform public.assert_clean(b);

  select count(*) into n_recent from public.chismes
   where author_id = uid and created_at > now() - interval '10 minutes';
  if n_recent >= 3 then raise exception 'slow_down'; end if;
  select count(*) into n_today from public.chismes
   where author_id = uid and created_at > now() - interval '1 day';
  if n_today >= 15 then raise exception 'daily_limit'; end if;

  if exists (select 1 from public.chismes
              where lower(body) = lower(b) and created_at > now() - interval '7 days') then
    raise exception 'duplicate';
  end if;

  insert into public.chismes (author_id, author_name, body, lang, tag)
  values (
    uid,
    case when coalesce(p_show_name, false) and not public.is_anonymous_user() then prof.username end,
    b, p_lang, p_tag
  )
  returning id into new_id;
  return new_id;
end $$;

revoke execute on function public.get_feed(text, text, int, int, boolean, text, bigint) from public;
revoke execute on function public.create_chisme(text, text, boolean, text) from public, anon;
grant execute on function public.get_feed(text, text, int, int, boolean, text, bigint) to anon, authenticated;
grant execute on function public.create_chisme(text, text, boolean, text) to authenticated;
