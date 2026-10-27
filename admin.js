(() => {
  "use strict";
  const cfg = window.OC_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  function ago(iso) {
    if (!iso) return "";
    const s = (Date.parse(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
    const steps = [[60, "second", 1], [3600, "minute", 60], [86400, "hour", 3600], [604800, "day", 86400], [2629800, "week", 604800], [Infinity, "month", 2629800]];
    for (const [limit, unit, div] of steps) if (Math.abs(s) < limit) return rtf.format(Math.round(s / div), unit);
    return "";
  }

  const ERR = {
    not_allowed: "Your account isn't an admin.",
    not_found: "That item is already gone.",
    network: "No connection. Check your internet and try again.",
  };
  const errText = (e) => {
    const m = String((e && e.message) || "").toLowerCase();
    const k = Object.keys(ERR).find((x) => m.includes(x));
    if (k) return ERR[k];
    if (m.includes("failed to fetch")) return ERR.network;
    return "Something went wrong. Try again.";
  };

  // ── Backend ────────────────────────────────────────────────────────
  function realApi() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const rpc = async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args || {});
      if (error) throw new Error(error.message);
      return data;
    };
    return {
      me: () => rpc("get_me"),
      stats: () => rpc("admin_stats"),
      queue: () => rpc("admin_report_queue"),
      recent: () => rpc("admin_recent", { p_limit: 40 }),
      banned: () => rpc("admin_banned"),
      keep: (it) => it.kind === "post" ? rpc("admin_set_hidden", { p_chisme: it.id, p_hidden: false })
                                       : rpc("admin_set_reply_hidden", { p_reply: it.id, p_hidden: false }),
      hide: (it) => it.kind === "post" ? rpc("admin_set_hidden", { p_chisme: it.id, p_hidden: true })
                                       : rpc("admin_set_reply_hidden", { p_reply: it.id, p_hidden: true }),
      remove: (it) => it.kind === "post" ? rpc("delete_chisme", { p_chisme: it.id })
                                         : rpc("delete_reply", { p_reply: it.id }),
      ban: (it) => it.kind === "post" ? rpc("admin_ban_author", { p_chisme: it.id })
                                      : rpc("admin_ban_reply_author", { p_reply: it.id }),
      unban: (b) => rpc("admin_unban", { p_user: b.id }),
    };
  }

  function demoApi() {
    const now = Date.now(), m = 60e3;
    const iso = (mins) => new Date(now - mins * m).toISOString();
    let items = [
      { kind: "post", id: 7, chisme_id: 7, body: "Everyone knows who I'm talking about. Starts with a J and works at the deli.", author_name: null, report_count: 4, hidden: false, created_at: iso(50), reasons: ["mean"] },
      { kind: "reply", id: 31, chisme_id: 3, body: "she deserved it honestly", author_name: null, report_count: 3, hidden: true, created_at: iso(20), parent_body: "En la boda de mi prima el DJ era su ex…" },
      { kind: "post", id: 9, chisme_id: 9, body: "Mi vecino pone reggaetón a las 7am todos los domingos.", author_name: "lachismosa", report_count: 1, hidden: false, created_at: iso(200) },
    ];
    let recent = [
      { kind: "reply", id: 40, chisme_id: 3, body: "esto es una telenovela", author_name: null, hidden: false, report_count: 0, created_at: iso(5), parent_body: "En la boda de mi prima el DJ era su ex…" },
      { kind: "post", id: 12, chisme_id: 12, body: "The bartender at my usual spot makes everyone's drink stronger when they tip in cash.", author_name: null, hidden: false, report_count: 0, created_at: iso(30) },
      ...items,
    ];
    let banned = [{ id: "x", code: "A1B2C3", username: null, posts: 6, replies: 2, banned_at: iso(1440), last_body: "buy followers cheap" }];
    const wait = (v) => new Promise((r) => setTimeout(() => r(v), 120));
    const drop = (it) => { items = items.filter((x) => !(x.kind === it.kind && x.id === it.id)); recent = recent.filter((x) => !(x.kind === it.kind && x.id === it.id)); };
    return {
      me: () => wait({ signed_in: true, is_admin: true }),
      stats: () => wait({ chismes: 128, chismes_today: 14, replies: 402, replies_today: 61, votes: 2311, votes_today: 290, people: 540, people_today: 37, accounts: 22, banned: banned.length, hidden: items.filter((x) => x.hidden).length, open_reports: items.length }),
      queue: () => wait(items.map((x) => ({ ...x }))),
      recent: () => wait(recent.map((x) => ({ ...x }))),
      banned: () => wait(banned.map((x) => ({ ...x }))),
      keep: (it) => { drop(it); return wait({ ok: true }); },
      hide: (it) => { recent.forEach((x) => { if (x.kind === it.kind && x.id === it.id) x.hidden = true; }); return wait({ ok: true }); },
      remove: (it) => { drop(it); return wait({ ok: true }); },
      ban: (it) => { drop(it); banned.unshift({ id: "y" + it.id, code: "F00D" + it.id, username: it.author_name, posts: 1, replies: 0, banned_at: new Date().toISOString(), last_body: it.body }); return wait({ ok: true }); },
      unban: (b) => { banned = banned.filter((x) => x.id !== b.id); return wait({ ok: true }); },
    };
  }

  const api = DEMO ? demoApi() : realApi();
  let tab = "reports";

  // ── Stats ──────────────────────────────────────────────────────────
  async function paintStats() {
    const s = await api.stats();
    const box = $("stats");
    box.textContent = "";
    const tiles = [
      ["Chismes", s.chismes, s.chismes_today],
      ["Replies", s.replies, s.replies_today],
      ["Tea cups", s.votes, s.votes_today],
      ["Visitors who joined in", s.people, s.people_today],
      ["Accounts", s.accounts],
      ["Open reports", s.open_reports, null, s.open_reports > 0],
      ["Hidden", s.hidden],
      ["Banned", s.banned],
    ];
    tiles.forEach(([label, n, today, alert]) => {
      const t = el("div", "stat" + (alert ? " stat-alert" : ""));
      t.append(el("span", "stat-n", Number(n || 0).toLocaleString()), el("span", "stat-l", label));
      if (today) t.appendChild(el("span", "stat-d", `+${Number(today).toLocaleString()} today`));
      box.appendChild(t);
    });
    $("reportsCount").textContent = s.open_reports > 0 ? String(s.open_reports) : "";
  }

  // ── Action buttons with an inline "are you sure" step ─────────────
  function actions(row, list) {
    const bar = el("div", "item-actions");
    list.forEach(([label, cls, fn, sure]) => {
      const b = el("button", "act " + (cls || ""), label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (!sure) return run(fn, bar);
        const c = el("div", "confirm-row");
        c.appendChild(el("span", null, sure));
        const yes = el("button", "act act-danger", "Yes"); yes.type = "button";
        const no = el("button", "act", "Cancel"); no.type = "button";
        yes.addEventListener("click", () => run(fn, bar));
        no.addEventListener("click", () => { c.remove(); bar.hidden = false; });
        c.append(yes, no);
        bar.hidden = true;
        row.appendChild(c);
      });
      bar.appendChild(b);
    });
    return bar;
  }

  async function run(fn, bar) {
    bar.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const msg = await fn();
      toast(msg);
      await refresh();
    } catch (e) {
      toast(errText(e));
      bar.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  }

  function itemCard(it, mode) {
    const row = el("article", "item" + (it.hidden ? " is-hidden" : ""));
    const top = el("div", "item-top");
    top.appendChild(el("span", "kind", it.kind === "post" ? "Chisme" : "Reply"));
    top.appendChild(el("span", null, it.author_name ? "@" + it.author_name : "Anonymous"));
    top.appendChild(el("time", null, ago(it.created_at)));
    if (it.report_count > 0) top.appendChild(el("span", "chip chip-red", `${it.report_count} report${it.report_count === 1 ? "" : "s"}`));
    if (it.hidden) top.appendChild(el("span", "chip chip-dim", "hidden"));
    row.appendChild(top);
    row.appendChild(el("p", "item-body", it.body));
    if (it.kind === "reply" && it.parent_body) row.appendChild(el("p", "item-parent", "On: " + it.parent_body));
    if (it.reasons && it.reasons.length) row.appendChild(el("p", "item-reasons", "Reasons: " + it.reasons.join(", ")));

    const what = it.kind === "post" ? "chisme" : "reply";
    const list = [];
    if (mode === "reports") {
      list.push(["Keep it", "act-ok", async () => { await api.keep(it); return "Kept. Reports cleared."; }]);
    } else {
      list.push(it.hidden
        ? ["Show again", "act-ok", async () => { await api.keep(it); return "Visible again"; }]
        : ["Hide", "", async () => { await api.hide(it); return "Hidden"; }]);
    }
    list.push(["Delete", "act-danger", async () => { await api.remove(it); return "Deleted"; }, `Delete this ${what} for good?`]);
    list.push(["Ban author", "act-danger", async () => { await api.ban(it); return "Author banned"; }, "Ban whoever wrote this and hide everything they posted?"]);
    row.appendChild(actions(row, list));
    return row;
  }

  function bannedCard(b) {
    const row = el("article", "item");
    const top = el("div", "item-top");
    top.appendChild(el("span", "kind", b.username ? "@" + b.username : "Anonymous #" + b.code));
    if (b.banned_at) top.appendChild(el("span", null, "banned " + ago(b.banned_at)));
    top.appendChild(el("span", "chip chip-dim", `${b.posts} chismes · ${b.replies} replies`));
    row.appendChild(top);
    if (b.last_body) row.appendChild(el("p", "item-parent", "Last thing they wrote: " + b.last_body));
    row.appendChild(actions(row, [["Unban", "", async () => { await api.unban(b); return "Unbanned. Their old posts stay hidden."; }, "Let them post and vote again?"]]));
    return row;
  }

  async function paintList() {
    const box = $("list");
    box.setAttribute("aria-busy", "true");
    try {
      let rows;
      if (tab === "reports") rows = await api.queue();
      else if (tab === "recent") rows = await api.recent();
      else rows = await api.banned();
      box.textContent = "";
      if (!rows || !rows.length) {
        box.appendChild(el("p", "admin-empty", tab === "reports" ? "No reports. All quiet. ☕" : tab === "banned" ? "Nobody is banned." : "Nothing posted yet."));
      } else {
        rows.forEach((r) => box.appendChild(tab === "banned" ? bannedCard(r) : itemCard(r, tab)));
      }
    } catch (e) {
      box.textContent = "";
      box.appendChild(el("p", "admin-empty", errText(e)));
    } finally { box.removeAttribute("aria-busy"); }
  }

  async function refresh() {
    try { await paintStats(); } catch (e) { toast(errText(e)); }
    await paintList();
  }

  async function init() {
    $("demoNote").hidden = !DEMO;
    let me;
    try { me = await api.me(); } catch { me = null; }
    if (!me || !me.is_admin) { $("gate").hidden = false; return; }
    $("panel").hidden = false;
    $("adminTabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      tab = b.dataset.tab;
      document.querySelectorAll("#adminTabs [data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      paintList();
    });
    refresh();
  }

  init();
})();
