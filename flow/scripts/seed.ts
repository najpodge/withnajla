// Loads src/data/seed.json into Supabase with the service role key.
// Idempotent: sections upsert on id and stuck points on code. Curated root
// causes and remediations (source = 'najla') are matched to existing rows by
// their order under each stuck point / root cause and updated in place, so
// changed wording never creates a duplicate. Seed items beyond the existing
// rows are inserted. It never deletes a row, never touches community rows and
// never touches `hidden`, so moderation survives a re-seed.
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

// Existing curated children of a parent, in curated order.
async function curated(table: 'root_causes' | 'remediations', parentCol: string, parentId: string) {
  return check(
    `${table} for ${parentId}`,
    await db.from(table).select('id').eq(parentCol, parentId).eq('source', 'najla').order('created_at').order('id'),
  ) as { id: string }[];
}

// Update the i-th existing curated row, or insert a new one; returns its id.
async function put(table: 'root_causes' | 'remediations', existing: { id: string }[], i: number, row: Record<string, unknown>, label: string) {
  const res = existing[i]
    ? await db.from(table).update(row).eq('id', existing[i].id).select('id')
    : await db.from(table).insert({ ...row, source: 'najla' }).select('id');
  return (check(label, res) as { id: string }[])[0].id;
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
  let leftover = 0;

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

    const rcs = await curated('root_causes', 'stuck_point_id', spRow.id);
    leftover += Math.max(0, rcs.length - sp.root_causes.length);

    for (const [i, rc] of sp.root_causes.entries()) {
      const rcId = await put(
        'root_causes',
        rcs,
        i,
        { stuck_point_id: spRow.id, text: rc.text, created_at: stamp() },
        `${sp.code} root cause "${rc.text}"`,
      );
      rcCount++;

      const rems = await curated('remediations', 'root_cause_id', rcId);
      leftover += Math.max(0, rems.length - rc.remediations.length);
      for (const [j, r] of rc.remediations.entries()) {
        await put(
          'remediations',
          rems,
          j,
          { root_cause_id: rcId, lens: r.lens, text: r.text, created_at: stamp() },
          `${sp.code} remediation "${r.text}"`,
        );
        remCount++;
      }
    }
  }

  console.log(
    `Seeded ${seed.sections.length} sections, ${seed.stuck_points.length} stuck points, ${rcCount} root causes, ${remCount} remediations.`,
  );
  if (leftover) console.log(`${leftover} curated rows have no match in seed.json and were left as they are.`);
}

main();
