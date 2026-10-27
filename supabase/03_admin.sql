-- ════════════════════════════════════════════════════════════════════
--  OnlyChismosas — admin page
--  Paste into Supabase → SQL Editor → New query → Run.  Run it once.
-- ════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists banned_at timestamptz;

-- ── Numbers for the dashboard ───────────────────────────────────────

create or replace function public.admin_stats()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  return json_build_object(
    'chismes',        (select count(*) from public.chismes),
    'chismes_today',  (select count(*) from public.chismes where created_at > now() - interval '1 day'),
    'replies',        (select count(*) from public.replies),
    'replies_today',  (select count(*) from public.replies where created_at > now() - interval '1 day'),
    'votes',          (select count(*) from public.votes),
    'votes_today',    (select count(*) from public.votes where created_at > now() - interval '1 day'),
    'people',         (select count(*) from public.profiles),
    'people_today',   (select count(*) from public.profiles where created_at > now() - interval '1 day'),
    'accounts',       (select count(*) from public.profiles where username is not null),
    'banned',         (select count(*) from public.profiles where banned),
    'hidden',         (select count(*) from public.chismes where hidden)
                    + (select count(*) from public.replies where hidden),
    'open_reports',   (select count(*) from public.chismes where report_count > 0)
                    + (select count(*) from public.replies where report_count > 0)
  );
end $$;

-- ── Everything that's been reported, posts and replies together ─────

create or replace function public.admin_report_queue()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  return coalesce((
    select json_agg(q order by q.report_count desc, q.created_at desc)
    from (
      select 'post' as kind, c.id, c.id as chisme_id, c.body, c.lang, c.author_name,
             c.report_count, c.hidden, c.created_at, null::text as parent_body,
             (select json_agg(r.reason) from public.reports r where r.chisme_id = c.id and r.reason is not null) as reasons
      from public.chismes c
      where c.report_count > 0
      union all
      select 'reply', rp.id, rp.chisme_id, rp.body, c.lang, rp.author_name,
             rp.report_count, rp.hidden, rp.created_at, left(c.body, 140), null
      from public.replies rp join public.chismes c on c.id = rp.chisme_id
      where rp.report_count > 0
      limit 200
    ) q
  ), '[]'::json);
end $$;

-- ── Latest posts & replies (newest first), including hidden ─────────

create or replace function public.admin_recent(p_limit int default 40)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  return coalesce((
    select json_agg(q order by q.created_at desc)
    from (
      (select 'post' as kind, c.id, c.id as chisme_id, c.body, c.author_name, c.hidden,
              c.report_count, c.created_at, null::text as parent_body
         from public.chismes c order by c.created_at desc limit least(p_limit, 100))
      union all
      (select 'reply', rp.id, rp.chisme_id, rp.body, rp.author_name, rp.hidden,
              rp.report_count, rp.created_at, left(c.body, 140)
         from public.replies rp join public.chismes c on c.id = rp.chisme_id
        order by rp.created_at desc limit least(p_limit, 100))
    ) q
  ), '[]'::json);
end $$;

-- ── Banned people (shown by a short code, never by email) ───────────

create or replace function public.admin_banned()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  return coalesce((
    select json_agg(b order by b.banned_at desc nulls last)
    from (
      select p.id, upper(left(replace(p.id::text, '-', ''), 6)) as code, p.username, p.banned_at,
             (select count(*) from public.chismes c where c.author_id = p.id) as posts,
             (select count(*) from public.replies r where r.author_id = p.id) as replies,
             (select body from (
                select body, created_at from public.chismes where author_id = p.id
                union all
                select body, created_at from public.replies where author_id = p.id
              ) x order by created_at desc limit 1) as last_body
      from public.profiles p
      where p.banned
      limit 200
    ) b
  ), '[]'::json);
end $$;

-- Unban: they can post and vote again. Their old posts stay hidden
-- unless you bring them back one by one.
create or replace function public.admin_unban(p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  update public.profiles set banned = false, banned_at = null where id = p_user;
  return json_build_object('ok', true);
end $$;

-- Record when someone was banned
create or replace function public.stamp_banned_at()
returns trigger language plpgsql as $$
begin
  if new.banned and not coalesce(old.banned, false) then new.banned_at := now(); end if;
  return new;
end $$;
drop trigger if exists profiles_banned_at on public.profiles;
create trigger profiles_banned_at before update of banned on public.profiles
  for each row execute function public.stamp_banned_at();

-- ── Permissions ─────────────────────────────────────────────────────

revoke execute on function public.admin_stats()          from public, anon;
revoke execute on function public.admin_report_queue()   from public, anon;
revoke execute on function public.admin_recent(int)      from public, anon;
revoke execute on function public.admin_banned()         from public, anon;
revoke execute on function public.admin_unban(uuid)      from public, anon;
revoke execute on function public.stamp_banned_at()      from public, anon, authenticated;
grant execute on function public.admin_stats()           to authenticated;
grant execute on function public.admin_report_queue()    to authenticated;
grant execute on function public.admin_recent(int)       to authenticated;
grant execute on function public.admin_banned()          to authenticated;
grant execute on function public.admin_unban(uuid)       to authenticated;
