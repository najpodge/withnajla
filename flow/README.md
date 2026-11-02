# Where flow gets stuck — flow.withnajla.com

Companion site for the LeadDev workshop "Getting back to flow in human–agent teams". Spec: `docs/BUILD_SPEC.md`. Deck images: `reference/`.

See **SETUP.md** for the step-by-step launch checklist.

Stack: Vite + TypeScript (static) · Supabase (Postgres, RLS, Realtime, Edge Function `submit`) · Cloudflare Turnstile · GitHub Pages.

## Local setup
    npm install
    cp .env.example .env   # fill in values
    npm run dev            # http://localhost:5173

Without `VITE_SUPABASE_URL` the site runs in **demo mode**: seed data in memory, contributions shared between tabs of one browser.

## Supabase (once)
1. Create a free project. In the SQL editor, paste and run the whole of `flow/supabase/migrations/20261101000000_init.sql`, once.
2. Create a Turnstile widget in Cloudflare (domains: flow.withnajla.com, localhost).
3. Secrets: `supabase secrets set TURNSTILE_SECRET_KEY=... RATE_LIMIT_SALT=<random> ALLOWED_ORIGINS=https://flow.withnajla.com,http://localhost:5173`
4. Deploy the function: `supabase functions deploy submit` (config.toml sets `verify_jwt = false`).

## Seed
    npm run seed   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env; idempotent, never touches `hidden`

## Hide a row (moderation)
Supabase → Table editor → `stuck_points` / `root_causes` / `remediations` → set `hidden = true`. Open pages drop it live.

## Export data
Table editor → table → Export → CSV, or SQL editor: `select * from remediations where source = 'community'` → Download CSV.

## Deploy
Push to `main` (changes under `flow/`). The Action `.github/workflows/deploy-flow.yml` at the repo root builds and deploys to GitHub Pages. Set repo **Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_TURNSTILE_SITE_KEY`. In Settings → Pages choose "GitHub Actions" and custom domain `flow.withnajla.com`; at the registrar add `CNAME flow → <github-user>.github.io`.

## Before the workshop
Free Supabase projects pause when idle: open the dashboard/site the day before. Get `terms.html` reviewed (EU contributors, reuse/resale licence).
