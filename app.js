(() => {
  "use strict";

  const cfg = window.OC_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
  const PAGE = 20;
  const $ = (id) => document.getElementById(id);

  // ── Small storage helpers (never break if storage is blocked) ──────
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ── Language ────────────────────────────────────────────────────────
  const guess = (navigator.language || "es").toLowerCase().startsWith("en") ? "en" : "es";
  let ui = store.get("oc_lang", guess) === "en" ? "en" : "es";
  const T = () => window.OC_I18N[ui];

  // ── Shared checks (mirrors the database rules for instant feedback) ─
  function precheck(text, isReply) {
    const b = text.trim();
    if (isReply) { if (b.length < 2 || b.length > 500) return "bad_reply_length"; }
    else if (b.length < 10 || b.length > 1000) return "bad_length";
    if (/(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|co|me|ly|xyz|app|info|biz|link|site|shop)(\b|\/))/i.test(b)) return "no_links";
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(b)) return "no_contact_info";
    if (/(^|[^a-z0-9])@[a-z0-9_.]{3,}/i.test(b)) return "no_contact_info";
    if (/(\d[ ().-]*){10,}/.test(b)) return "no_contact_info";
    if (/\b\d{1,6}\s+([a-z]+\s+){1,3}(st|street|ave|avenue|blvd|boulevard|road|rd|lane|ln|drive|dr|calle|avenida)\b/i.test(b)) return "no_contact_info";
    return null;
  }

  class AppError extends Error { constructor(code) { super(code); this.code = code; } }

  function toCode(err) {
    const m = String((err && (err.message || err.error_description || err.code)) || "").toLowerCase();
    const known = Object.keys(window.OC_I18N.en.errors);
    const hit = known.find((k) => m.includes(k));
    if (hit) return hit;
    if (m.includes("invalid login")) return "bad_login";
    if (m.includes("password")) return "weak_password";
    if (m.includes("already registered") || m.includes("already been registered")) return "email_taken";
    if (m.includes("captcha")) return "captcha";
    if (m.includes("failed to fetch") || m.includes("network")) return "network";
    return "generic";
  }

  // ── Human check (Cloudflare Turnstile, optional) ────────────────────
  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (!turnstileLoading) {
      turnstileLoading = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.onload = () => res(); s.onerror = () => rej(new AppError("captcha"));
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }
  async function getCaptcha() {
    if (!cfg.TURNSTILE_SITE_KEY) return undefined;
    await loadTurnstile();
    const dlg = $("captchaDlg");
    const box = $("captchaBox");
    box.textContent = "";
    $("captchaTitle").textContent = T().captchaTitle;
    return new Promise((resolve, reject) => {
      const holder = document.createElement("div");
      box.appendChild(holder);
      dlg.showModal();
      const onClose = () => reject(new AppError("captcha"));
      dlg.addEventListener("cancel", onClose, { once: true });
      window.turnstile.render(holder, {
        sitekey: cfg.TURNSTILE_SITE_KEY,
        language: ui,
        callback: (token) => { dlg.removeEventListener("cancel", onClose); dlg.close(); resolve(token); },
        "error-callback": () => { dlg.close(); reject(new AppError("captcha")); },
      });
    });
  }

  // ── Backend: real (Supabase) ────────────────────────────────────────
  function supabaseApi() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const rpc = async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args || {});
      if (error) throw new AppError(toCode(error));
      return data;
    };
    return {
      async ensureSession() {
        const { data } = await sb.auth.getSession();
        if (data.session) return;
        const captchaToken = await getCaptcha();
        const { error } = await sb.auth.signInAnonymously({ options: { captchaToken } });
        if (error) throw new AppError(toCode(error));
      },
      me: () => rpc("get_me"),
      feed: (o) => rpc("get_feed", {
        p_sort: o.sort === "reported" ? "new" : o.sort,
        p_lang: o.lang === "all" ? null : o.lang,
        p_limit: PAGE, p_offset: o.offset, p_reported: o.sort === "reported",
        p_tag: o.tag || null, p_id: null,
      }),
      one: async (id) => (await rpc("get_feed", { p_sort: "new", p_lang: null, p_limit: 1, p_offset: 0, p_reported: false, p_tag: null, p_id: id }))[0] || null,
      today: async () => (await rpc("get_feed", { p_sort: "today", p_lang: null, p_limit: 1, p_offset: 0, p_reported: false, p_tag: null, p_id: null }))[0] || null,
      post: (body, lang, showName, tag) => rpc("create_chisme", { p_body: body, p_lang: lang, p_show_name: showName, p_tag: tag || null }),
      vote: (id, v) => rpc("cast_vote", { p_chisme: id, p_value: v }),
      report: (id) => rpc("report_chisme", { p_chisme: id, p_reason: null }),
      del: (id) => rpc("delete_chisme", { p_chisme: id }),
      hide: (id, h) => rpc("admin_set_hidden", { p_chisme: id, p_hidden: h }),
      ban: (id) => rpc("admin_ban_author", { p_chisme: id }),
      setUsername: (u) => rpc("set_username", { p_username: u }),
      replies: (id) => rpc("get_replies", { p_chisme: id }),
      reply: (id, body, showName) => rpc("create_reply", { p_chisme: id, p_body: body, p_show_name: showName }),
      reportReply: (rid) => rpc("report_reply", { p_reply: rid }),
      delReply: (rid) => rpc("delete_reply", { p_reply: rid }),
      hideReply: (rid, h) => rpc("admin_set_reply_hidden", { p_reply: rid, p_hidden: h }),
      banReplyAuthor: (rid) => rpc("admin_ban_reply_author", { p_reply: rid }),
      async signUp(email, password, username) {
        const captchaToken = await getCaptcha();
        const { data, error } = await sb.auth.signUp({ email, password, options: { captchaToken, data: { username } } });
        if (error) throw new AppError(toCode(error));
        return { needsConfirm: !data.session };
      },
      async signIn(email, password) {
        const captchaToken = await getCaptcha();
        const { error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken } });
        if (error) throw new AppError(toCode(error));
      },
      async signOut() { await sb.auth.signOut(); },
      async pendingUsername() {
        const { data } = await sb.auth.getUser();
        return data && data.user && data.user.user_metadata ? data.user.user_metadata.username : null;
      },
    };
  }

  // ── Backend: demo (in memory, for previews) ─────────────────────────
  function demoApi() {
    const H = 3600e3, now = Date.now();
    let nextId = 100;
    const seed = [
      ["es", "La vecina del 3B dice que va al gimnasio todos los días… pero la vi en la panadería a las 6am comprando conchas. Todos los días. 💀", null, 41, 3, 2],
      ["en", "My coworker 'works from home' every Friday. His Instagram story was a boat in Miami. Every. Friday.", null, 33, 6, 5],
      ["es", "En la boda de mi prima el DJ era su ex. Nadie dijo nada. La novia bailó con él la de Selena. 👀", "lachismosa", 58, 4, 9],
      ["en", "Someone in my building has been stealing packages and leaving thank-you notes. Polite crime is still crime.", null, 19, 2, 14],
      ["es", "Mi tía jura que su novio es piloto. El señor nunca ha salido de Queens. ✈️", null, 27, 11, 20],
      ["en", "The bartender at my usual spot makes everyone's drink stronger when they tip in cash. I said what I said.", null, 12, 1, 30],
      ["es", "El grupo de WhatsApp de la familia se puso intenso porque alguien llevó flan comprado a la fiesta y dijo que era casero.", null, 64, 2, 40],
    ];
    let rows = seed.map(([lang, body, author, h, i, ageH], k) => ({
      id: k + 1, body, lang, author_name: author, hot_cups: h, iced_cups: i, score: h - i,
      report_count: 0, hidden: false, created_at: new Date(now - ageH * H).toISOString(),
      is_mine: false, my_vote: null,
    }));
    let me = { signed_in: false, is_anonymous: true, username: null, is_admin: false, banned: false };
    const demoTags = ["vecinos", "trabajo", "familia", "vecinos", "familia", "trabajo", "familia"];
    rows.forEach((r, k) => { r.author = "op" + r.id; r.reply_count = 0; r.tag = demoTags[k] || null; });
    let nextReply = 1;
    let replies = [];
    const seedReplies = {
      1: [["a", "jajaja la conozco 💀 dice que el pan es 'carga de carbohidratos'", 100], ["op1", "carga de carbohidratos todos los días a las 6am??", 90], ["b", "honestly respect", 80], ["a", "la próxima le pregunto qué gym es 👀", 60]],
      3: [["a", "nooo la de Selena 😭", 400], ["b", "y el novio??", 380], ["op3", "el novio estaba en la barra pidiendo otro tequila", 370], ["c", "esto es una telenovela", 300]],
      2: [["a", "the boat is the office now", 200]],
    };
    Object.entries(seedReplies).forEach(([cid, list]) => list.forEach(([author, body, minsAgo]) => {
      replies.push({ id: nextReply++, chisme_id: +cid, author, author_name: null, body, hidden: false, report_count: 0, created_at: new Date(now - minsAgo * 60e3).toISOString() });
    }));
    const recount = (cid) => { const r = rows.find((x) => x.id === cid); if (r) r.reply_count = replies.filter((x) => x.chisme_id === cid && !x.hidden).length; };
    rows.forEach((r) => recount(r.id));
    const hot = (r) => (r.score + r.reply_count / 2 + 1) / Math.pow((Date.now() - Date.parse(r.created_at)) / H + 2, 1.5);
    const wait = (v) => new Promise((r) => setTimeout(() => r(v), 120));
    return {
      async ensureSession() { me.signed_in = true; },
      async me() { return wait({ ...me }); },
      async feed(o) {
        let list = rows.filter((r) => (!r.hidden || me.is_admin) && (o.lang === "all" || r.lang === o.lang) && (!o.tag || r.tag === o.tag));
        if (o.sort === "reported") list = list.filter((r) => r.report_count > 0);
        const by = { new: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at), top: (a, b) => b.score - a.score, hot: (a, b) => hot(b) - hot(a) };
        list.sort(by[o.sort] || by.new);
        return wait(list.slice(o.offset, o.offset + PAGE).map((r) => ({ ...r })));
      },
      async one(id) { const r = rows.find((x) => x.id === id && (!x.hidden || me.is_admin)); return wait(r ? { ...r } : null); },
      async today() {
        const day = rows.filter((r) => !r.hidden && Date.now() - Date.parse(r.created_at) < 24 * H && r.score + r.reply_count >= 3)
          .sort((a, b) => (b.score * 2 + b.reply_count) - (a.score * 2 + a.reply_count));
        return wait(day[0] ? { ...day[0] } : null);
      },
      async post(body, lang, showName, tag) {
        const code = precheck(body);
        if (code) throw new AppError(code);
        rows.unshift({ id: nextId++, body: body.trim(), lang, tag: tag || null, author_name: showName && me.username ? me.username : null,
          hot_cups: 0, iced_cups: 0, score: 0, report_count: 0, hidden: false, created_at: new Date().toISOString(),
          is_mine: true, my_vote: null, author: "me", reply_count: 0 });
        return wait(nextId - 1);
      },
      async vote(id, v) {
        const r = rows.find((x) => x.id === id);
        if (r.my_vote === 1) r.hot_cups--; if (r.my_vote === -1) r.iced_cups--;
        r.my_vote = v === 0 ? null : v;
        if (v === 1) r.hot_cups++; if (v === -1) r.iced_cups++;
        r.score = r.hot_cups - r.iced_cups;
        return wait({ hot_cups: r.hot_cups, iced_cups: r.iced_cups, score: r.score, my_vote: r.my_vote });
      },
      async report(id) { const r = rows.find((x) => x.id === id); r.report_count++; return wait({ ok: true }); },
      async del(id) { rows = rows.filter((x) => x.id !== id); return wait({ ok: true }); },
      async hide(id, h) { const r = rows.find((x) => x.id === id); r.hidden = h; if (!h) r.report_count = 0; return wait({ ok: true }); },
      async ban(id) { const r = rows.find((x) => x.id === id); r.hidden = true; return wait({ ok: true }); },
      async setUsername(u) {
        if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new AppError("bad_username");
        me.username = u; return wait({ ...me });
      },
      async signUp(email, password, username) {
        if (password.length < 8) throw new AppError("weak_password");
        if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new AppError("bad_username");
        me = { signed_in: true, is_anonymous: false, username, is_admin: true, banned: false };
        return wait({ needsConfirm: false });
      },
      async replies(cid) {
        const op = rows.find((x) => x.id === cid);
        if (!op) throw new AppError("not_found");
        const list = replies.filter((x) => x.chisme_id === cid && (!x.hidden || me.is_admin)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        const order = [];
        list.forEach((x) => { if (x.author !== op.author && !order.includes(x.author)) order.push(x.author); });
        return wait(list.map((x) => ({
          id: x.id, body: x.body, author_name: x.author_name, hidden: x.hidden, created_at: x.created_at,
          who_n: x.author === op.author ? 0 : order.indexOf(x.author) + 1,
          is_mine: x.author === "me", report_count: me.is_admin ? x.report_count : 0,
        })));
      },
      async reply(cid, body, showName) {
        const code = precheck(body, true);
        if (code) throw new AppError(code);
        replies.push({ id: nextReply++, chisme_id: cid, author: "me", author_name: showName && me.username ? me.username : null,
          body: body.trim(), hidden: false, report_count: 0, created_at: new Date().toISOString() });
        recount(cid);
        return wait(nextReply - 1);
      },
      async reportReply(rid) { const x = replies.find((y) => y.id === rid); x.report_count++; return wait({ ok: true }); },
      async delReply(rid) { const x = replies.find((y) => y.id === rid); replies = replies.filter((y) => y !== x); recount(x.chisme_id); return wait({ ok: true }); },
      async hideReply(rid, h) { const x = replies.find((y) => y.id === rid); x.hidden = h; recount(x.chisme_id); return wait({ ok: true }); },
      async banReplyAuthor(rid) { const x = replies.find((y) => y.id === rid); x.hidden = true; recount(x.chisme_id); return wait({ ok: true }); },
      async signIn() { me = { signed_in: true, is_anonymous: false, username: "kisho", is_admin: true, banned: false }; return wait(); },
      async signOut() { me = { signed_in: false, is_anonymous: true, username: null, is_admin: false, banned: false }; return wait(); },
      async pendingUsername() { return null; },
    };
  }

  const api = DEMO ? demoApi() : supabaseApi();

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    sort: store.get("oc_sort", "hot"),
    lang: store.get("oc_flang", "all"),
    tag: null,           // topic filter
    postTag: null,       // topic picked in the composer
    single: null,        // id when viewing one chisme from a shared link
    items: [], offset: 0, done: false, loading: false,
    me: { signed_in: false, is_anonymous: true, username: null, is_admin: false },
  };
  const TAGS = ["amor", "trabajo", "familia", "vecinos", "amigas", "random"];
  if (!["hot", "new", "top"].includes(state.sort)) state.sort = "hot";

  // ── Toast ───────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  const errText = (e) => T().errors[(e && e.code) || toCode(e)] || T().errors.generic;

  // ── Time ago ────────────────────────────────────────────────────────
  function ago(iso) {
    const s = (Date.parse(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(ui, { numeric: "auto", style: "short" });
    const steps = [[60, "second"], [3600, "minute", 60], [86400, "hour", 3600], [604800, "day", 86400], [2629800, "week", 604800], [31557600, "month", 2629800], [Infinity, "year", 31557600]];
    for (const [limit, unit, div] of steps) {
      if (Math.abs(s) < limit) return rtf.format(Math.round(s / (div || 1)), unit);
    }
    return "";
  }

  // ── Render: static text ─────────────────────────────────────────────
  function paintText() {
    const t = T();
    document.documentElement.lang = ui;
    $("langBtn").textContent = ui === "es" ? "EN" : "ES";
    $("langBtn").setAttribute("aria-label", ui === "es" ? "Switch to English" : "Cambiar a español");
    $("tagline").textContent = t.tagline;
    $("bodyLabel").textContent = t.bodyLabel;
    $("body").placeholder = t.placeholder;
    $("postBtn").textContent = t.post;
    $("rulesLink").textContent = t.rulesLink;
    $("rulesLink2").textContent = t.rulesLink;
    $("footNote").textContent = t.footNote;
    $("allLbl").textContent = t.all;
    $("moreBtn").textContent = t.more;
    $("rulesTitle").textContent = t.rulesTitle;
    $("rulesOk").textContent = t.gotIt;
    const rl = $("rulesList"); rl.textContent = "";
    t.rules.forEach((r) => { const li = document.createElement("li"); li.textContent = r; rl.appendChild(li); });
    document.querySelectorAll("#sortTabs [data-sort]").forEach((b) => {
      b.textContent = t[b.dataset.sort];
      b.setAttribute("aria-selected", String(b.dataset.sort === state.sort));
    });
    document.querySelectorAll('input[name="flang"]').forEach((i) => { i.checked = i.value === state.lang; });
    $("demoNote").hidden = !DEMO;
    $("demoNote").textContent = t.demo;
    $("tagPickLbl").textContent = t.tagPick;
    $("backBtn").textContent = t.backToAll;
    paintChips($("tagPick"), [null, ...TAGS], state.postTag, (k) => (k ? t.tags[k] : t.noTag), (k) => { state.postTag = k; paintText(); });
    paintChips($("tagFilter"), [null, ...TAGS], state.tag, (k) => (k ? t.tags[k] : t.allTopics), (k) => {
      state.tag = k; paintText(); loadFeed(true);
    });
    paintMe();
  }

  function paintChips(box, keys, current, label, onPick) {
    box.textContent = "";
    keys.forEach((k) => {
      const b = el("button", "chip-btn", label(k));
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(k === current));
      b.addEventListener("click", () => { if (k !== current) onPick(k); });
      box.appendChild(b);
    });
  }

  function paintMe() {
    const t = T(), me = state.me;
    const real = me.signed_in && !me.is_anonymous;
    $("acctBtn").textContent = real ? (me.username ? "@" + me.username : t.account) : t.signIn;
    $("showNameRow").hidden = !(real && me.username);
    if (me.username) $("showNameText").textContent = t.showName(me.username);
    $("reportedTab").hidden = !me.is_admin;
    $("adminLink").hidden = !me.is_admin;
    if (!me.is_admin && state.sort === "reported") state.sort = "hot";
  }

  // ── Render: feed ────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function bubble(item, idx) {
    const t = T();
    const a = el("article", "bubble " + (idx % 2 ? "from-right" : "from-left"));
    a.dataset.id = item.id;
    if (item.hidden) a.classList.add("is-hidden");

    const p = el("p", "body", item.body);
    p.lang = item.lang;
    a.appendChild(p);

    const meta = el("div", "meta");
    meta.appendChild(el("span", "who", item.author_name ? "@" + item.author_name : t.anon));
    meta.appendChild(el("time", "when", ago(item.created_at)));
    meta.lastChild.dateTime = item.created_at;
    meta.appendChild(el("span", "lang-tag", item.lang.toUpperCase()));
    if (item.tag && t.tags[item.tag]) {
      const tg = el("button", "topic", t.tags[item.tag]);
      tg.type = "button";
      tg.addEventListener("click", () => { state.tag = item.tag; goAll(); });
      meta.appendChild(tg);
    }
    if (item.hidden) meta.appendChild(el("span", "flag", t.hiddenTag));
    if (item.report_count > 0 && state.me.is_admin) meta.appendChild(el("span", "flag", t.reportsTag(item.report_count)));
    a.appendChild(meta);

    const bar = el("div", "bar");
    const hotB = el("button", "cup cup-hot");
    hotB.type = "button"; hotB.title = t.hotCup; hotB.setAttribute("aria-label", t.hotCup);
    hotB.setAttribute("aria-pressed", String(item.my_vote === 1));
    hotB.append(el("span", "cup-ico", "☕"), el("span", "cup-n", String(item.hot_cups)));
    hotB.addEventListener("click", () => vote(item, item.my_vote === 1 ? 0 : 1, a));

    const icedB = el("button", "cup cup-iced");
    icedB.type = "button"; icedB.title = t.icedCup; icedB.setAttribute("aria-label", t.icedCup);
    icedB.setAttribute("aria-pressed", String(item.my_vote === -1));
    icedB.append(el("span", "cup-ico", "🧊"), el("span", "cup-n", String(item.iced_cups)));
    icedB.addEventListener("click", () => vote(item, item.my_vote === -1 ? 0 : -1, a));

    const open = openThreads.has(item.id);
    const chatB = el("button", "cup cup-chat");
    chatB.type = "button";
    chatB.setAttribute("aria-expanded", String(open));
    chatB.setAttribute("aria-label", item.reply_count ? t.repliesBtn(item.reply_count) : t.replyFirst);
    chatB.append(el("span", "cup-ico", "💬"), el("span", "cup-n", item.reply_count ? String(item.reply_count) : t.replyFirst));
    const shareB = el("button", "icon-btn");
    shareB.type = "button";
    shareB.title = t.share;
    shareB.setAttribute("aria-label", t.share);
    shareB.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    shareB.addEventListener("click", () => share(item));
    bar.append(hotB, icedB, chatB, shareB);

    const entries = [];
    if (!item.is_mine) entries.push([t.report, () => report(item)]);
    if (item.is_mine || state.me.is_admin) entries.push([t.del, () => del(item), true]);
    if (state.me.is_admin) {
      entries.push([item.hidden ? t.unhide : t.hide, () => hide(item, !item.hidden)]);
      if (!item.is_mine) entries.push([t.ban, () => ban(item), true]);
    }
    if (entries.length) bar.appendChild(menuFor(entries));
    a.appendChild(bar);

    const th = el("div", "thread");
    th.hidden = !open;
    a.appendChild(th);
    chatB.addEventListener("click", () => toggleThread(item, a));
    if (open) {
      if (threadCache.has(item.id)) paintThread(item, th, threadCache.get(item.id));
      else loadThread(item, a);
    }
    return a;
  }

  function menuFor(entries) {
    const menu = el("details", "more");
    const sum = el("summary", null, "···");
    sum.setAttribute("aria-label", "Options");
    menu.appendChild(sum);
    const list = el("div", "more-list");
    entries.forEach(([label, fn, danger]) => {
      const b = el("button", danger ? "danger" : null, label);
      b.type = "button";
      b.addEventListener("click", () => { menu.open = false; fn(); });
      list.appendChild(b);
    });
    menu.appendChild(list);
    return menu;
  }

  // ── Replies (group chat under each chisme) ──────────────────────────
  const openThreads = new Set();
  const threadCache = new Map();

  function setChatCount(item, node) {
    const n = node.querySelector(".cup-chat .cup-n");
    if (n) n.textContent = item.reply_count ? String(item.reply_count) : T().replyFirst;
    const b = node.querySelector(".cup-chat");
    if (b) b.setAttribute("aria-label", item.reply_count ? T().repliesBtn(item.reply_count) : T().replyFirst);
  }

  function toggleThread(item, node) {
    const th = node.querySelector(".thread");
    const btn = node.querySelector(".cup-chat");
    if (openThreads.has(item.id)) {
      openThreads.delete(item.id);
      th.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    openThreads.add(item.id);
    th.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    loadThread(item, node);
  }

  async function loadThread(item, node) {
    const th = node.querySelector(".thread");
    if (!threadCache.has(item.id)) { th.textContent = ""; th.appendChild(el("p", "thread-empty", "…")); }
    try {
      const list = await api.replies(item.id);
      threadCache.set(item.id, list);
      item.reply_count = list.filter((r) => !r.hidden).length;
      setChatCount(item, node);
      paintThread(item, th, list);
    } catch (e) { toast(errText(e)); }
  }

  function whoLabel(r) {
    const t = T();
    let name = r.author_name ? "@" + r.author_name : r.who_n === 0 ? t.op : t.anonN(r.who_n);
    if (r.author_name && r.who_n === 0) name += " · " + t.op;
    if (r.is_mine) return r.who_n === 0 ? `${t.op} (${t.you})` : t.youCap;
    return name;
  }

  function paintThread(item, th, list) {
    const t = T();
    th.textContent = "";
    const log = el("div", "chat");
    if (!list.length) log.appendChild(el("p", "thread-empty", t.noReplies));
    let prevWho = null;
    list.forEach((r) => {
      const key = r.is_mine ? "me" : r.who_n;
      const m = el("div", "msg " + (r.is_mine ? "msg-mine" : "msg-them") + (r.who_n === 0 ? " msg-op" : ""));
      if (r.hidden) m.classList.add("is-hidden");
      if (key !== prevWho) m.appendChild(el("span", "msg-who", whoLabel(r)));
      else m.classList.add("msg-cont");
      prevWho = key;
      const b = el("p", "msg-body", r.body);
      b.lang = item.lang;
      m.appendChild(b);
      const meta = el("div", "msg-meta");
      meta.appendChild(el("time", null, ago(r.created_at)));
      if (r.hidden) meta.appendChild(el("span", "flag", t.hiddenTag));
      if (r.report_count > 0) meta.appendChild(el("span", "flag", t.reportsTag(r.report_count)));
      const entries = [];
      if (!r.is_mine) entries.push([t.report, () => replyAction(item, () => api.reportReply(r.id), t.reportedOk)]);
      if (r.is_mine || state.me.is_admin) entries.push([t.del, () => { if (confirm(t.confirmDel)) replyAction(item, () => api.delReply(r.id), t.deleted); }, true]);
      if (state.me.is_admin) {
        entries.push([r.hidden ? t.unhide : t.hide, () => replyAction(item, () => api.hideReply(r.id, !r.hidden), r.hidden ? t.unhiddenOk : t.hiddenOk)]);
        if (!r.is_mine) entries.push([t.ban, () => { if (confirm(t.confirmBan)) replyAction(item, () => api.banReplyAuthor(r.id), t.banned); }, true]);
      }
      meta.appendChild(menuFor(entries));
      m.appendChild(meta);
      log.appendChild(m);
    });
    th.appendChild(log);

    // Reply box
    const f = el("form", "reply-form");
    const input = el("textarea");
    input.rows = 1; input.maxLength = 500; input.placeholder = t.replyPlaceholder;
    input.id = "reply-" + item.id;
    input.setAttribute("aria-label", t.replyPlaceholder);
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
    const send = el("button", "send", t.send);
    send.type = "submit";
    f.append(input, send);
    let asMe = null;
    if (state.me.username && !state.me.is_anonymous) {
      const lab = el("label", "check check-small");
      asMe = el("input"); asMe.type = "checkbox";
      lab.append(asMe, el("span", null, "@" + state.me.username));
      f.appendChild(lab);
    }
    const msg = el("p", "form-msg");
    f.appendChild(msg);
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const code = precheck(input.value, true);
      if (code) { msg.textContent = t.errors[code]; msg.className = "form-msg err"; return; }
      send.disabled = true; msg.textContent = "";
      try {
        await api.ensureSession();
        await api.reply(item.id, input.value, asMe ? asMe.checked : false);
        input.value = "";
        const node = th.closest(".bubble");
        await loadThread(item, node);
        const again = node.querySelector(".reply-form textarea");
        if (again) again.focus();
        refreshMe();
      } catch (e) {
        msg.textContent = errText(e); msg.className = "form-msg err";
      } finally { send.disabled = false; }
    });
    th.appendChild(f);
  }

  async function replyAction(item, fn, okMsg) {
    try {
      await api.ensureSession();
      await fn();
      toast(okMsg);
      const node = document.querySelector(`.bubble[data-id="${item.id}"]`);
      if (node) await loadThread(item, node);
    } catch (e) { toast(errText(e)); }
  }

  function paintFeed() {
    const f = $("feed");
    const single = state.single != null;
    f.textContent = "";
    state.items.forEach((it, i) => f.appendChild(bubble(it, i)));
    $("moreBtn").hidden = single || state.done || state.items.length === 0;
    const empty = !state.loading && state.items.length === 0;
    $("emptyMsg").hidden = !empty;
    $("emptyMsg").textContent = single ? T().notFoundPost : state.sort === "reported" ? T().emptyReported : T().empty;
  }

  async function loadFeed(reset) {
    if (state.single != null) return loadSingle();
    if (state.loading) return;
    state.loading = true;
    if (reset) { state.offset = 0; state.done = false; }
    try {
      const rows = await api.feed({ sort: state.sort, lang: state.lang, tag: state.tag, offset: state.offset });
      state.items = reset ? rows : state.items.concat(rows);
      state.offset += rows.length;
      state.done = rows.length < PAGE;
    } catch (e) {
      toast(errText(e));
    } finally {
      state.loading = false;
      paintFeed();
    }
  }

  // ── One chisme from a shared link (#c123) ───────────────────────────
  async function loadSingle() {
    state.loading = true;
    try {
      const one = await api.one(state.single);
      state.items = one ? [one] : [];
      if (one) openThreads.add(one.id);
    } catch (e) {
      state.items = [];
      toast(errText(e));
    } finally {
      state.loading = false;
      state.done = true;
      paintFeed();
      window.scrollTo(0, 0);
    }
  }

  function route() {
    const m = /^#c(\d+)$/.exec(location.hash);
    state.single = m ? Number(m[1]) : null;
    const single = state.single != null;
    $("singleBar").hidden = !single;
    $("composer").hidden = single;
    $("feedTools").hidden = single;
    $("tagFilter").hidden = single;
    loadFeed(true);
  }

  function goAll() {
    if (state.single != null) {
      try { history.pushState("", "", location.pathname + location.search); } catch { location.hash = ""; }
      route();
    } else {
      paintText();
      loadFeed(true);
    }
    window.scrollTo(0, 0);
  }

  // ── Share ───────────────────────────────────────────────────────────
  async function share(item) {
    const t = T();
    const url = `${location.origin}${location.pathname}#c${item.id}`;
    const excerpt = item.body.length > 90 ? item.body.slice(0, 90).trimEnd() + "…" : item.body;
    if (navigator.share) {
      try { await navigator.share({ title: "OnlyChismosas", text: `${t.shareText} "${excerpt}"`, url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); toast(t.copied); }
    catch { toast(url); }
  }

  // ── Actions ─────────────────────────────────────────────────────────
  async function vote(item, value, node) {
    try {
      await api.ensureSession();
      const r = await api.vote(item.id, value);
      Object.assign(item, r);
      const idx = state.items.indexOf(item);
      const fresh = bubble(item, idx);
      node.replaceWith(fresh);
      if (value !== 0) {
        const cup = fresh.querySelector(value === 1 ? ".cup-hot" : ".cup-iced");
        cup.classList.add("just-voted");
      }
      refreshMe();
    } catch (e) { toast(errText(e)); }
  }

  async function report(item) {
    try { await api.ensureSession(); await api.report(item.id); toast(T().reportedOk); }
    catch (e) { toast(errText(e)); }
  }

  async function del(item) {
    if (!confirm(T().confirmDel)) return;
    try { await api.del(item.id); toast(T().deleted); state.items = state.items.filter((x) => x !== item); paintFeed(); }
    catch (e) { toast(errText(e)); }
  }

  async function hide(item, h) {
    try { await api.hide(item.id, h); toast(h ? T().hiddenOk : T().unhiddenOk); loadFeed(true); }
    catch (e) { toast(errText(e)); }
  }

  async function ban(item) {
    if (!confirm(T().confirmBan)) return;
    try { await api.ban(item.id); toast(T().banned); loadFeed(true); }
    catch (e) { toast(errText(e)); }
  }

  async function refreshMe() {
    try {
      state.me = await api.me();
      if (state.me.signed_in && !state.me.is_anonymous && !state.me.username) {
        const pending = await api.pendingUsername();
        if (pending) { try { state.me = await api.setUsername(pending); } catch { /* user can set it later */ } }
      }
    } catch { /* stay as guest */ }
    paintMe();
  }

  // ── Composer ────────────────────────────────────────────────────────
  function initComposer() {
    const body = $("body"), count = $("count"), msg = $("postMsg");
    document.querySelectorAll('input[name="plang"]').forEach((i) => { i.checked = i.value === ui; });
    body.addEventListener("input", () => { count.textContent = `${body.value.length} / 1000`; msg.textContent = ""; });
    $("composer").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = body.value;
      const lang = document.querySelector('input[name="plang"]:checked').value;
      const code = precheck(text);
      if (code) { msg.textContent = T().errors[code]; msg.className = "form-msg err"; return; }
      const btn = $("postBtn");
      btn.disabled = true; btn.textContent = T().posting; msg.textContent = "";
      try {
        await api.ensureSession();
        await api.post(text, lang, $("showName").checked, state.postTag);
        body.value = ""; count.textContent = "0 / 1000";
        toast(T().posted);
        state.sort = "new"; store.set("oc_sort", "new");
        state.postTag = null; state.tag = null;
        paintText();
        await loadFeed(true);
        refreshMe();
      } catch (e) {
        msg.textContent = errText(e); msg.className = "form-msg err";
      } finally {
        btn.disabled = false; btn.textContent = T().post;
      }
    });
  }

  // ── Account dialog ──────────────────────────────────────────────────
  let acctMode = "signin";
  function field(type, name, label, extra) {
    const wrap = el("label", "field");
    wrap.appendChild(el("span", null, label));
    const i = el("input");
    i.type = type; i.name = name; i.required = true;
    Object.assign(i, extra || {});
    wrap.appendChild(i);
    return wrap;
  }

  function paintAcct() {
    const t = T(), box = $("acctBody"), me = state.me;
    box.textContent = "";
    const real = me.signed_in && !me.is_anonymous;
    const msg = el("p", "form-msg");
    msg.setAttribute("role", "status");

    if (real) {
      box.appendChild(el("h2", null, t.signedInAs(me.username)));
      if (!me.username) {
        const f = el("div", "stack");
        f.appendChild(field("text", "u", t.username, { autocomplete: "username", maxLength: 20 }));
        f.appendChild(el("p", "hint", t.usernameHint));
        const save = el("button", "btn", t.save); save.type = "button";
        save.addEventListener("click", async () => {
          try { state.me = await api.setUsername(f.querySelector("input").value.trim()); paintMe(); paintAcct(); }
          catch (e) { msg.textContent = errText(e); msg.className = "form-msg err"; }
        });
        f.appendChild(save);
        box.appendChild(f);
      }
      const out = el("button", "btn btn-ghost", t.signOut); out.type = "button";
      out.addEventListener("click", async () => {
        await api.signOut(); await refreshMe(); $("acctDlg").close(); toast(t.signedOut); loadFeed(true);
      });
      box.append(out, msg);
      return;
    }

    const signup = acctMode === "signup";
    box.appendChild(el("h2", null, signup ? t.signUpTitle : t.signInTitle));
    box.appendChild(el("p", "hint", t.whyAccount));
    const f = el("div", "stack");
    if (signup) {
      f.appendChild(field("text", "username", t.username, { autocomplete: "username", maxLength: 20 }));
      f.appendChild(el("p", "hint", t.usernameHint));
    }
    f.appendChild(field("email", "email", t.email, { autocomplete: "email" }));
    f.appendChild(field("password", "password", t.password, { autocomplete: signup ? "new-password" : "current-password", minLength: 8 }));
    const go = el("button", "btn", signup ? t.create : t.enter); go.type = "button";
    go.addEventListener("click", async () => {
      const v = (n) => (f.querySelector(`[name="${n}"]`) || {}).value || "";
      go.disabled = true; msg.textContent = "";
      try {
        if (signup) {
          const u = v("username").trim();
          if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new AppError("bad_username");
          if (v("password").length < 8) throw new AppError("weak_password");
          const r = await api.signUp(v("email").trim(), v("password"), u);
          if (r.needsConfirm) { msg.textContent = t.checkEmail; msg.className = "form-msg ok"; return; }
        } else {
          await api.signIn(v("email").trim(), v("password"));
        }
        await refreshMe();
        $("acctDlg").close();
        toast(t.welcome);
        loadFeed(true);
      } catch (e) {
        msg.textContent = errText(e); msg.className = "form-msg err";
      } finally { go.disabled = false; }
    });
    f.appendChild(go);
    const sw = el("button", "link", signup ? t.toSignIn : t.toSignUp); sw.type = "button";
    sw.addEventListener("click", () => { acctMode = signup ? "signin" : "signup"; paintAcct(); });
    f.appendChild(sw);
    box.append(f, msg);
  }

  // ── Wiring ──────────────────────────────────────────────────────────
  function init() {
    paintText();
    initComposer();

    $("langBtn").addEventListener("click", () => {
      ui = ui === "es" ? "en" : "es";
      store.set("oc_lang", ui);
      paintText(); paintFeed();
    });
    $("acctBtn").addEventListener("click", () => { paintAcct(); $("acctDlg").showModal(); });
    const openRules = () => $("rulesDlg").showModal();
    $("rulesLink").addEventListener("click", openRules);
    $("rulesLink2").addEventListener("click", openRules);

    $("sortTabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sort]");
      if (!b || b.dataset.sort === state.sort) return;
      state.sort = b.dataset.sort;
      if (state.sort !== "reported") store.set("oc_sort", state.sort);
      paintText(); loadFeed(true);
    });
    $("langFilter").addEventListener("change", (e) => {
      state.lang = e.target.value; store.set("oc_flang", state.lang); loadFeed(true);
    });
    $("moreBtn").addEventListener("click", () => loadFeed(false));

    // Close dialogs by tapping the backdrop
    document.querySelectorAll("dialog").forEach((d) => {
      d.addEventListener("click", (e) => { if (e.target === d && d.id !== "captchaDlg") d.close(); });
    });

    // Show house rules once on first visit
    if (store.get("oc_rules_seen", "") !== "1") { store.set("oc_rules_seen", "1"); setTimeout(openRules, 400); }

    $("backBtn").addEventListener("click", goAll);
    window.addEventListener("hashchange", route);
    refreshMe().then(route);
  }

  init();
})();
