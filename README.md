# OnlyChismosas

Anonymous, bilingual (ES/EN) gossip board. People spill a chisme and vote with ☕ hot tea (true) or 🧊 iced tea (not buying it).

Cost: $0. Supabase (free) holds the data, GitHub Pages (free) hosts the site, and Squarespace keeps the domain.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js`, `i18n.js` | The website |
| `config.js` | Your keys go here. **This is the only file you edit.** |
| `supabase/schema.sql` | The database. Paste it into Supabase once. |
| `CNAME` | Tells GitHub Pages to use onlychismosas.com |

While `config.js` is empty, the site runs in demo mode with fake posts.

---

## Setup (about 30 minutes, all free)

### 1. Supabase (the database)
1. Sign up at **supabase.com** and click **New project**. Name it `onlychismosas`, pick region **East US**, and save the database password somewhere.
2. Open **SQL Editor**, click **New query**, paste all of `supabase/schema.sql`, and click **Run**. You should see "Success". Then do the same with `supabase/02_replies.sql` (replies / group chat) `supabase/03_admin.sql` (admin page) and `supabase/04_extras.sql` (topics, share links, Chisme del día).
3. Go to **Authentication → Sign In / Providers**:
   - Turn **on** "Allow anonymous sign-ins". Visitors can't vote or post without this.
   - Under **Email**, turn **off** "Confirm email". The free plan only sends a few emails per hour.
4. Go to **Authentication → URL Configuration** and set **Site URL** to `https://onlychismosas.com`.
5. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`.

### 2. Cloudflare Turnstile (spam check, optional but recommended)
1. Sign up at **dash.cloudflare.com**, then go to **Turnstile → Add site**. Domain: `onlychismosas.com`. Widget mode: **Managed**.
2. Copy the **Site Key** into `config.js` (`TURNSTILE_SITE_KEY`).
3. Copy the **Secret Key** into Supabase: **Authentication → Attack Protection → Enable CAPTCHA protection**, provider **Turnstile**, then paste and save.

You don't need to move your domain to Cloudflare.

### 3. GitHub Pages (hosting)
1. Sign up at **github.com** and create a new **public** repository named `onlychismosas`.
2. Click **Add file → Upload files** and drag in everything from this folder, including the `supabase` folder and `CNAME`. Click **Commit**.
3. Go to **Settings → Pages**. Under Source, pick **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. In the same place, set **Custom domain** to `onlychismosas.com` and save.

### 4. Squarespace (point the domain at the site)
In Squarespace: **Domains → onlychismosas.com → DNS → DNS Settings**.
1. Delete Squarespace's default records for `@` and `www`.
2. Add these four **A** records, all with Host `@`:
   - `185.199.108.153`
   - `185.199.109.153`
   - `185.199.110.153`
   - `185.199.111.153`
3. Add one **CNAME** record: Host `www`, Data `YOUR-GITHUB-USERNAME.github.io`.

DNS takes anywhere from 10 minutes to a few hours. Once GitHub Pages shows the domain as verified, tick **Enforce HTTPS**.

### 5. Make yourself the admin
1. Go to onlychismosas.com and create your account with **Sign in → Create one**.
2. In Supabase **SQL Editor**, run this with your email:
   ```sql
   update public.profiles set is_admin = true
   where id = (select id from auth.users where email = 'YOUR@EMAIL.com');
   ```
3. Reload the site. An **Admin** button appears at the top (or go to onlychismosas.com/admin.html): numbers, every report, latest posts, and banned people. Posts and replies also get Hide, Delete and Ban in their `···` menu.

---

## How the protection works
- **No contact info:** phone numbers, emails, @handles and street addresses are blocked.
- **No links:** links are blocked, which stops spam.
- **Rate limits:** 3 posts per 10 minutes and 15 per day per person. Votes and reports are rate-limited too, and duplicate posts are blocked.
- **Auto-hide:** after 5 reports, a post hides itself until you review it.
- **Anonymous posts stay anonymous.** Nobody, including other users, can see who wrote one. **Ban the author** bans that person without revealing who they are.
- **Human check:** Turnstile asks visitors to prove they're human before their first vote or post, and on sign-in.

## Good to know
- Free Supabase projects pause after 7 days with zero visitors. If that happens, open the Supabase dashboard and click **Restore**.
- To change text in either language, edit `i18n.js`.
