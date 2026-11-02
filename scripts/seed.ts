// Loads src/data/seed.json into Supabase with the service role key.
// Idempotent: upserts sections on id, stuck points on code, root causes on
// (stuck_point_id, text) and remediations on (root_cause_id, lens, text).
// It never touches `hidden`, so moderation survives a re-seed.
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

async function main() {
  check(
    'sections',
    await db.from('sections').upsert(
      seed.sections.map((s, i) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        signals: s.signals,
        sort: i,
      })),
      { onConflict: 'id' },
    ),
  );

  let rcCount = 0;
  let remCount = 0;

  for (const sp of seed.stuck_points) {
    const [spRow] = check(
      `stuck point ${sp.code}`,
      await db
        .from('stuck_points')
        .upsert(
          {
            section: sp.section,
            code: sp.code,
            name: sp.name,
            symptom: sp.symptom,
            signals: sp.signals,
            source: 'najla',
            created_at: stamp(),
          },
          { onConflict: 'code' },
        )
        .select('id'),
    ) as { id: string }[];

    for (const rc of sp.root_causes) {
      const [rcRow] = check(
        `root cause "${rc.text}"`,
        await db
          .from('root_causes')
          .upsert(
            { stuck_point_id: spRow.id, text: rc.text, source: 'najla', created_at: stamp() },
            { onConflict: 'stuck_point_id,text' },
          )
          .select('id'),
      ) as { id: string }[];
      rcCount++;

      check(
        `remediations for "${rc.text}"`,
        await db.from('remediations').upsert(
          rc.remediations.map((r) => ({
            root_cause_id: rcRow.id,
            lens: r.lens,
            text: r.text,
            source: 'najla',
            created_at: stamp(),
          })),
          { onConflict: 'root_cause_id,lens,text' },
        ),
      );
      remCount += rc.remediations.length;
    }
  }

  console.log(
    `Seeded ${seed.sections.length} sections, ${seed.stuck_points.length} stuck points, ${rcCount} root causes, ${remCount} remediations.`,
  );
}

main();
