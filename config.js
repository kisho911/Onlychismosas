// ─────────────────────────────────────────────────────────────
//  OnlyChismosas settings — the only file you need to edit.
//
//  Leave SUPABASE_URL empty and the site runs in DEMO mode
//  (fake posts, nothing saved) so you can preview it.
// ─────────────────────────────────────────────────────────────
window.OC_CONFIG = {
  // Supabase → Project Settings → API → "Project URL"
  SUPABASE_URL: "",

  // Supabase → Project Settings → API → "anon public" key
  // (this one is meant to be public — it's safe to put here)
  SUPABASE_ANON_KEY: "",

  // Optional spam check. Cloudflare → Turnstile → your site → "Site Key".
  // Leave empty to skip the "I'm human" check.
  TURNSTILE_SITE_KEY: "",
};
