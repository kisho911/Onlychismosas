// ─────────────────────────────────────────────────────────────
//  OnlyChismosas settings — the only file you need to edit.
//
//  Leave SUPABASE_URL empty and the site runs in DEMO mode
//  (fake posts, nothing saved) so you can preview it.
// ─────────────────────────────────────────────────────────────
window.OC_CONFIG = {
  // Supabase → Project Settings → API → "Project URL"
  SUPABASE_URL: "https://gznltvqezzwfhbizqval.supabase.co",

  // Supabase → Project Settings → API → "anon public" key
  // (this one is meant to be public — it's safe to put here)
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6bmx0dnFlenp3ZmhiaXpxdmFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNjUxOTgsImV4cCI6MjEwODY0MTE5OH0.pokbhuLN8usJQ0oQcVYufWAVRrVs-h86XLCJGa4ZogM",

  // Optional spam check. Cloudflare → Turnstile → your site → "Site Key".
  // Leave empty to skip the "I'm human" check.
  TURNSTILE_SITE_KEY: "",
};
