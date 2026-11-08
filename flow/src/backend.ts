import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import seed from './data/seed.json';
import type {
  ChangeEvent,
  Remediation,
  RootCause,
  Signal,
  Snapshot,
  StuckPoint,
  Submission,
  SubmitResult,
  TableName,
} from './types';
import { authorIndexes, myAuthorName } from './authors';
import { validateSubmission } from './validate';

export interface Backend {
  mode: 'live' | 'demo';
  needsTurnstile: boolean;
  load(): Promise<Snapshot>;
  subscribe(onChange: (e: ChangeEvent) => void): void;
  submit(sub: Submission, turnstileToken: string | null): Promise<SubmitResult>;
}

const TABLES: TableName[] = ['stuck_points', 'root_causes', 'remediations', 'signals'];
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export async function createBackend(): Promise<Backend> {
  if (URL_ && KEY) return liveBackend(URL_, KEY);
  return demoBackend();
}

// ---------------------------------------------------------------------------
// Live: Supabase
// ---------------------------------------------------------------------------

async function liveBackend(url: string, key: string): Promise<Backend> {
  const { createClient } = await import('@supabase/supabase-js');
  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function all<T>(table: string, cols = '*'): Promise<T[]> {
    const page = 1000;
    const rows: T[] = [];
    for (let from = 0; ; from += page) {
      const { data, error } = await db
        .from(table)
        .select(cols)
        .order('created_at')
        .order('id')
        .range(from, from + page - 1);
      if (error) throw error;
      rows.push(...(data as T[]));
      if (!data || data.length < page) return rows;
    }
  }

  return {
    mode: 'live',
    needsTurnstile: true,

    async load() {
      const [sections, stuck_points, root_causes, remediations, signals] = await Promise.all([
        db.from('sections').select('*').order('sort').then((r) => {
          if (r.error) throw r.error;
          return r.data;
        }),
        all<StuckPoint>('stuck_points'),
        all<RootCause>('root_causes'),
        all<Remediation>('remediations'),
        // Added in a later migration; the page still works without it.
        all<Signal>('signals').catch(() => [] as Signal[]),
      ]);
      return { sections, stuck_points, root_causes, remediations, signals } as Snapshot;
    },

    subscribe(onChange) {
      let channel: RealtimeChannel = db.channel('library');
      for (const table of TABLES) {
        channel = channel.on(
          'postgres_changes' as never,
          { event: '*', schema: 'public', table },
          (p: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
            if (p.eventType === 'DELETE') {
              onChange({ kind: 'remove', table, id: p.old.id as string });
            } else if ((p.new as { hidden?: boolean }).hidden) {
              onChange({ kind: 'remove', table, id: p.new.id as string });
            } else {
              onChange({ kind: 'upsert', table, row: p.new as never });
            }
          },
        );
      }
      channel = channel.on('broadcast', { event: 'visibility' }, ({ payload }) => {
        const { table, id, hidden } = payload as { table: TableName; id: string; hidden: boolean };
        // Unhiding arrives as a normal UPDATE once the row is visible again.
        if (hidden && TABLES.includes(table)) onChange({ kind: 'remove', table, id });
      });

      let connectedBefore = false;
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // After a reconnect we may have missed events: reload everything.
          if (connectedBefore) onChange({ kind: 'resync' });
          connectedBefore = true;
        }
      });
    },

    async submit(sub, turnstileToken) {
      const res = await fetch(`${url}/functions/v1/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ ...sub, author: authorIndexes(), turnstileToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      return data as SubmitResult;
    },
  };
}

// ---------------------------------------------------------------------------
// Demo: no Supabase configured. Seed data in memory; contributions are shared
// between tabs of this browser so realtime can be tried locally.
// ---------------------------------------------------------------------------

const DEMO_KEY = 'flow-demo-community-v1';

function demoBackend(): Backend {
  const base = Date.parse('2026-11-01T00:00:00Z');
  let tick = 0;
  const stamp = () => new Date(base + tick++ * 1000).toISOString();
  const id = () => crypto.randomUUID();

  const snap: Snapshot = {
    sections: seed.sections.map((s, i) => ({ ...s, sort: i })) as Snapshot['sections'],
    stuck_points: [],
    root_causes: [],
    remediations: [],
    signals: [],
  };
  for (const sp of seed.stuck_points) {
    const spId = `sp-${sp.code}`;
    snap.stuck_points.push({
      id: spId, created_at: stamp(), source: 'najla',
      section: sp.section as StuckPoint['section'], code: sp.code, name: sp.name, symptom: sp.symptom, signals: sp.signals,
    });
    sp.root_causes.forEach((rc, i) => {
      const rcId = `${spId}-rc${i}`;
      snap.root_causes.push({ id: rcId, created_at: stamp(), source: 'najla', stuck_point_id: spId, text: rc.text });
      rc.remediations.forEach((r, j) => {
        snap.remediations.push({
          id: `${rcId}-r${j}`, created_at: stamp(), source: 'najla', root_cause_id: rcId, lens: r.lens as Remediation['lens'], text: r.text,
        });
      });
    });
  }

  type Stored = { table: TableName; row: StuckPoint | RootCause | Remediation | Signal };
  const readStored = (): Stored[] => {
    try {
      return JSON.parse(localStorage.getItem(DEMO_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const store = (s: Stored[]) => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(s));
    } catch {
      /* private mode: tabs still sync over BroadcastChannel */
    }
  };
  const apply = (s: Stored) => {
    const list = snap[s.table] as { id: string }[];
    if (!list.some((r) => r.id === s.row.id)) list.push(s.row);
  };
  readStored().forEach(apply);

  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('flow-demo') : null;

  return {
    mode: 'demo',
    needsTurnstile: false,

    async load() {
      return structuredClone(snap);
    },

    subscribe(onChange) {
      bc?.addEventListener('message', (ev: MessageEvent<Stored[]>) => {
        for (const s of ev.data) {
          apply(s);
          onChange({ kind: 'upsert', table: s.table, row: s.row });
        }
      });
    },

    async submit(sub) {
      const err = validateSubmission(sub);
      if (err) throw new Error(err);
      await new Promise((r) => setTimeout(r, 300));
      const now = () => new Date().toISOString();
      const out: SubmitResult = { stuck_point: null, root_cause: null, remediations: [], signals: [] };
      if (sub.type === 'signal') {
        const sp = snap.stuck_points.find((s) => s.id === sub.stuck_point_id)!;
        for (const text of sub.signals) {
          const known = [...sp.signals, ...snap.signals.filter((s) => s.stuck_point_id === sp.id).map((s) => s.text)];
          if (known.some((k) => k.toLowerCase() === text.toLowerCase())) throw new Error('That signal is already listed');
          out.signals.push({ id: id(), created_at: now(), source: 'community', author: myAuthorName(), stuck_point_id: sp.id, text });
        }
        const batch: Stored[] = out.signals.map((row) => ({ table: 'signals' as const, row }));
        batch.forEach(apply);
        store([...readStored(), ...batch]);
        bc?.postMessage(batch);
        return out;
      }
      let spId = sub.type === 'root_cause' ? sub.stuck_point_id : '';
      let rcId = sub.type === 'remediation' ? sub.root_cause_id : '';

      if (sub.type === 'stuck_point') {
        const n = Math.max(0, ...snap.stuck_points.filter((s) => s.section === sub.section).map((s) => +s.code.slice(1))) + 1;
        spId = id();
        out.stuck_point = {
          id: spId, created_at: now(), source: 'community', author: myAuthorName(), section: sub.section, code: sub.section + n,
          name: sub.name, symptom: sub.symptom, signals: sub.signals,
        };
      }
      if (sub.type !== 'remediation') {
        if (snap.root_causes.some((r) => r.stuck_point_id === spId && r.text === sub.root_cause)) {
          throw new Error('That idea is already in the library.');
        }
        rcId = id();
        out.root_cause = { id: rcId, created_at: now(), source: 'community', author: myAuthorName(), stuck_point_id: spId, text: sub.root_cause };
      }
      for (const r of sub.remediations) {
        if (snap.remediations.some((x) => x.root_cause_id === rcId && x.lens === r.lens && x.text === r.text)) {
          throw new Error('That idea is already in the library.');
        }
        out.remediations.push({ id: id(), created_at: now(), source: 'community', author: myAuthorName(), root_cause_id: rcId, lens: r.lens, text: r.text });
      }

      const batch: Stored[] = [
        ...(out.stuck_point ? [{ table: 'stuck_points' as const, row: out.stuck_point }] : []),
        ...(out.root_cause ? [{ table: 'root_causes' as const, row: out.root_cause }] : []),
        ...out.remediations.map((row) => ({ table: 'remediations' as const, row })),
      ];
      batch.forEach(apply);
      store([...readStored(), ...batch]);
      bc?.postMessage(batch);
      return out;
    },
  };
}
