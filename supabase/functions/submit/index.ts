// Edge Function: submit
// Verifies Cloudflare Turnstile, rate-limits, then calls submit_idea with the
// service role key (which only exists in Supabase secrets).

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET_KEY') ?? '';
const RATE_SALT = Deno.env.get('RATE_LIMIT_SALT') ?? crypto.randomUUID();
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ??
  'https://flow.withnajla.com,http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// In-memory only: keys are salted hashes, never written anywhere, and vanish
// when the function instance recycles. No IP address is stored.
const hits = new Map<string, number[]>();

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

async function clientKey(req: Request): Promise<string> {
  const raw = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const bytes = new TextEncoder().encode(RATE_SALT + raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return false;
}

async function verifyTurnstile(token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  const form = new FormData();
  form.append('secret', TURNSTILE_SECRET);
  form.append('response', token);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 20_000) return json({ error: 'Submission too large' }, 413, origin);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { turnstileToken, ...payload } = body;

  if (!(await verifyTurnstile(turnstileToken))) {
    return json({ error: 'Could not verify you are human. Reload the page and try again.' }, 403, origin);
  }

  if (rateLimited(await clientKey(req))) {
    return json({ error: 'That is a lot of ideas in a short time. Try again in a few minutes.' }, 429, origin);
  }

  const { data, error } = await db.rpc('submit_idea', { payload });
  if (error) {
    // 22023 = our own validation messages, safe to show. 23505 = duplicate.
    if (error.code === '22023') return json({ error: error.message }, 400, origin);
    if (error.code === '23505') return json({ error: 'That idea is already in the library.' }, 409, origin);
    if (error.code === '54000') return json({ error: error.message }, 429, origin);
    console.error('submit_idea failed', error.code, error.message);
    return json({ error: 'Something went wrong. Please try again.' }, 500, origin);
  }

  return json(data, 200, origin);
});
