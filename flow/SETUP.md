# Setup checklist

Work through these in order. Steps marked **(Claude)** I can do for you once you say so; everything else needs your accounts.

Keep a scratch note of the values you collect. Three are **public** (safe in the browser) and three are **secret** (never in the repo, never prefixed `VITE_`).

| Value | Where it comes from | Public or secret |
|---|---|---|
| Project URL | Supabase → Project Settings → API | public |
| Anon / publishable key | Supabase → Project Settings → API | public |
| Service role / secret key | Supabase → Project Settings → API | **secret** |
| Turnstile site key | Cloudflare → Turnstile | public |
| Turnstile secret key | Cloudflare → Turnstile | **secret** |
| Rate-limit salt | any random string (`openssl rand -hex 16`) | **secret** |

---

## 1. GitHub repo (Claude, with your OK)

- [ ] Create the repo and push. Repo: `najpodge/withnajla` (public), this project in `flow/`. GitHub Pages is free only for public repos, unless you're on GitHub Pro.
- [ ] Settings → Pages → Source: **GitHub Actions**.

The first deploy runs on push. Until step 4 is done it ships in demo mode, with the yellow "Demo mode" note showing.

## 2. Supabase (you)

- [ ] Sign up at supabase.com and create a project (free tier). Pick an EU region, e.g. Frankfurt, since your contributors are in the EU.
- [ ] SQL Editor → paste all of `supabase/migrations/20261101000000_init.sql` → Run.
- [ ] Project Settings → Realtime: check that public channel access is allowed (the default). Hidden rows disappear live through a public broadcast.
- [ ] Copy the Project URL, the anon/publishable key and the service role/secret key.

## 3. Cloudflare Turnstile (you)

- [ ] Sign up at cloudflare.com (free). You don't need to move your domain.
- [ ] Turnstile → Add widget. Hostnames: `flow.withnajla.com` and `localhost`. Widget mode: **Invisible**, or Managed if you'd rather show a checkbox when Cloudflare is unsure.
- [ ] Copy the site key and the secret key.

## 4. Connect everything

**Local `.env`** (you; it stays on your laptop and is gitignored):
- [ ] `cp .env.example .env` and fill in all five values.

**Seed the library** (Claude, or you):
- [ ] `npm run seed`. It should print 7 sections, 16 stuck points, 34 root causes and 115 remediations. You can safely run it again.

**Deploy the Edge Function** (you, once; it needs a browser login):
- [ ] `brew install supabase/tap/supabase`
- [ ] `supabase login`
- [ ] `supabase link --project-ref <your-project-ref>` (the ref is the part of the URL before `.supabase.co`)
- [ ] `supabase secrets set TURNSTILE_SECRET_KEY=... RATE_LIMIT_SALT=... ALLOWED_ORIGINS=https://flow.withnajla.com,http://localhost:5173`
- [ ] `supabase functions deploy submit`

**GitHub Actions variables** (Claude can set these once the repo exists, or you): Settings → Secrets and variables → Actions → **Variables** tab:
- [ ] `VITE_SUPABASE_URL`
- [ ] `VITE_SUPABASE_ANON_KEY`
- [ ] `VITE_TURNSTILE_SITE_KEY`
- [ ] Then Actions → "Deploy flow.withnajla.com" → Run workflow.

## 5. Domain (you)

- [ ] At the registrar for withnajla.com, add a DNS record: type `CNAME`, name `flow`, value `najpodge.github.io`.
- [ ] GitHub → Settings → Pages → Custom domain: `flow.withnajla.com` → Save. When the certificate is ready (minutes to an hour), tick **Enforce HTTPS**.

## 6. Check it works (Claude can run most of these)

- [ ] Open the site in two browsers, e.g. Chrome and Safari, or a laptop and a phone. Add a remediation in one; it should appear, highlighted, in the other within a couple of seconds.
- [ ] Try all three add types. A root cause with no remediation should be blocked by the form.
- [ ] In the Supabase table editor, set `hidden = true` on a community row; it should vanish from the open pages.
- [ ] Scan the QR code on your slide with your phone.

## 7. Before the workshop

- [ ] **Have the terms reviewed** (`terms.html`). They are a draft, written to allow reuse and resale of contributions. EU points to check with a lawyer: the licence grant, the moral-rights waiver (limited in some EU countries), the GDPR wording about Cloudflare, and that Najla is named as controller.
- [ ] The day before: open the Supabase dashboard and the site. Free projects pause after about a week without activity.
- [ ] Optional: delete any test ideas you added while checking (set `hidden = true`, or delete the rows).

## Day-to-day

- **Hide spam:** Supabase → Table editor → pick the table → set `hidden` to `true`.
- **Export:** Table editor → Export to CSV, or SQL editor: `select * from remediations where source = 'community';` → Download.
- **Edit curated content:** change `src/data/seed.json`, then run `npm run seed`. It never un-hides anything.
