// Loads src/data/seed.json into Supabase with the service role key.
//
// Idempotent and non-destructive:
// - sections upsert on id
// - curated signals (table `metrics`) are matched to existing curated rows by
//   their order within each section and updated in place
// - root causes are matched by text; new ones are inserted
// - curated remediations are matched by their order under each root cause
// - signal → root cause links are added when missing
// It never deletes a row, never touches community rows and never touches
// `hidden`, so moderation survives a re-seed.
//
//   npm run seed        (reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env)

import { createClient } from '@supabase/supabase-js';
import seed from '../src/data/seed.json' with { type: 'json' };

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

// Deterministic timestamps keep the curated order stable across re-seeds.
const base = Date.parse('2026-11-01T00:00:00Z');
let tick = 0;
const stamp = () => new Date(base + tick++ * 1000).toISOString();

function check<T>(label: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) {
    console.error(`${label}: ${res.error.message}`);
    process.exit(1);
  }
  return res.data as T;
}

type Id = { id: string };

async function main() {
  check(
    'sections',
    await db.from('sections').upsert(
      seed.sections.map((s, i) => ({ id: s.id, name: s.name, description: s.description, signals: s.signals, sort: i })),
      { onConflict: 'id' },
    ),
  );

  // Root causes and their remediations.
  const rcIds = new Map<string, string>();
  let remCount = 0;
  let leftover = 0;
  for (const rc of seed.root_causes) {
    const found = check(
      `root cause "${rc.text}"`,
      await db.from('root_causes').select('id').ilike('text', rc.text.replace(/[%_\\]/g, '\\$&')),
    ) as Id[];
    const rcId = found[0]
      ? found[0].id
      : (check(
          `root cause "${rc.text}"`,
          await db.from('root_causes').insert({ text: rc.text, source: 'najla', created_at: stamp() }).select('id'),
        ) as Id[])[0].id;
    rcIds.set(rc.text, rcId);

    const rems = check(
      `remediations for "${rc.text}"`,
      await db.from('remediations').select('id').eq('root_cause_id', rcId).eq('source', 'najla').order('created_at').order('id'),
    ) as Id[];
    leftover += Math.max(0, rems.length - rc.remediations.length);
    for (const [j, r] of rc.remediations.entries()) {
      const row = { root_cause_id: rcId, lens: r.lens, text: r.text, created_at: stamp() };
      check(
        `remediation "${r.text}"`,
        rems[j]
          ? await db.from('remediations').update(row).eq('id', rems[j].id)
          : await db.from('remediations').insert({ ...row, source: 'najla' }),
      );
      remCount++;
    }
  }

  // Signals, section by section, and their links to root causes.
  let linkCount = 0;
  for (const section of seed.sections) {
    const mine = seed.signals.filter((s) => s.section === section.id);
    const existing = check(
      `signals in ${section.id}`,
      await db.from('metrics').select('id').eq('section', section.id).eq('source', 'najla').order('sort').order('created_at'),
    ) as Id[];
    leftover += Math.max(0, existing.length - mine.length);

    for (const [i, s] of mine.entries()) {
      const row = {
        section: s.section,
        arrow: s.arrow,
        name: s.name,
        looks_like: s.looks_like || null,
        on_deck: s.on_deck,
        sort: seed.signals.indexOf(s),
        created_at: stamp(),
      };
      const metricId = existing[i]
        ? (check(`signal "${s.name}"`, await db.from('metrics').update(row).eq('id', existing[i].id).select('id')) as Id[])[0].id
        : (check(`signal "${s.name}"`, await db.from('metrics').insert({ ...row, source: 'najla' }).select('id')) as Id[])[0].id;

      const links = check(
        `links for "${s.name}"`,
        await db.from('metric_causes').select('id, root_cause_id, source').eq('metric_id', metricId),
      ) as { id: string; root_cause_id: string; source: string }[];
      for (const text of s.root_causes) {
        const rcId = rcIds.get(text);
        if (!rcId) {
          console.error(`Signal "${s.name}" lists an unknown root cause: "${text}"`);
          process.exit(1);
        }
        const link = links.find((l) => l.root_cause_id === rcId);
        const created_at = stamp();
        if (!link) {
          check(
            `link "${s.name}" → "${text}"`,
            await db.from('metric_causes').insert({ metric_id: metricId, root_cause_id: rcId, source: 'najla', created_at }),
          );
        } else if (link.source === 'najla') {
          check(`link "${s.name}" → "${text}"`, await db.from('metric_causes').update({ created_at }).eq('id', link.id));
        }
        linkCount++;
      }
    }
  }

  console.log(
    `Seeded ${seed.sections.length} sections, ${seed.signals.length} signals, ${seed.root_causes.length} root causes, ${remCount} remediations, ${linkCount} links.`,
  );
  if (leftover) console.log(`${leftover} curated rows have no match in seed.json and were left as they are.`);
}

main();
