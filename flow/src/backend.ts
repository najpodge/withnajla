import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import seed from './data/seed.json';
import type {
  ChangeEvent,
  Metric,
  MetricCause,
  Remediation,
  RootCause,
  Snapshot,
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

const TABLES: TableName[] = ['metrics', 'metric_causes', 'root_causes', 'remediations'];
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
      const [sections, metrics, metric_causes, root_causes, remediations] = await Promise.all([
        db.from('sections').select('*').order('sort').then((r) => {
          if (r.error) throw r.error;
          return r.data;
        }),
        all<Metric>('metrics'),
        all<MetricCause>('metric_causes'),
        all<RootCause>('root_causes', 'id, created_at, text, source, author, hidden'),
        all<Remediation>('remediations'),
      ]);
      return { sections, metrics, metric_causes, root_causes, remediations } as Snapshot;
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

const DEMO_KEY = 'flow-demo-community-v2';

function demoBackend(): Backend {
  const base = Date.parse('2026-11-01T00:00:00Z');
  let tick = 0;
  const stamp = () => new Date(base + tick++ * 1000).toISOString();
  const id = () => crypto.randomUUID();
  const najla = () => ({ created_at: stamp(), source: 'najla' as const });

  const snap: Snapshot = {
    sections: seed.sections.map((s, i) => ({ ...s, sort: i })) as Snapshot['sections'],
    metrics: [],
    metric_causes: [],
    root_causes: [],
    remediations: [],
  };
  const rcByText = new Map<string, string>();
  seed.root_causes.forEach((rc, i) => {
    const rcId = `rc-${i}`;
    rcByText.set(rc.text, rcId);
    snap.root_causes.push({ id: rcId, ...najla(), text: rc.text });
    rc.remediations.forEach((r, j) => {
      snap.remediations.push({ id: `${rcId}-r${j}`, ...najla(), root_cause_id: rcId, lens: r.lens as Remediation['lens'], text: r.text });
    });
  });
  seed.signals.forEach((s, i) => {
    const mId = `m-${i}`;
    snap.metrics.push({
      id: mId, ...najla(), section: s.section as Metric['section'], arrow: s.arrow as Metric['arrow'],
      name: s.name, looks_like: s.looks_like || null, on_deck: s.on_deck, sort: i,
    });
    s.root_causes.forEach((t, j) => {
      snap.metric_causes.push({ id: `${mId}-l${j}`, ...najla(), metric_id: mId, root_cause_id: rcByText.get(t)! });
    });
  });

  type Stored = { table: TableName; row: Metric | MetricCause | RootCause | Remediation };
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

    // Mirrors submit_metric / submit_idea in the database.
    async submit(sub) {
      const err = validateSubmission(sub);
      if (err) throw new Error(err);
      await new Promise((r) => setTimeout(r, 300));
      const community = () => ({ id: id(), created_at: new Date().toISOString(), source: 'community' as const, author: myAuthorName() });
      const out: SubmitResult = { metric: null, root_causes: [], links: [], remediations: [] };
      const batch: Stored[] = [];
      if (sub.type === 'remediation') {
        for (const r of sub.remediations) {
          if (snap.remediations.some((x) => x.root_cause_id === sub.root_cause_id && x.lens === r.lens && x.text === r.text)) continue;
          const row: Remediation = { ...community(), root_cause_id: sub.root_cause_id, lens: r.lens, text: r.text };
          out.remediations.push(row);
          batch.push({ table: 'remediations', row });
        }
      } else {
        let metricId = sub.type === 'cause' ? sub.metric_id : '';
        if (sub.type === 'metric') {
          if (snap.metrics.some((m) => m.section === sub.section && m.name.toLowerCase() === sub.name.toLowerCase())) {
            throw new Error('That signal is already listed in this section');
          }
          out.metric = { ...community(), section: sub.section, arrow: sub.arrow, name: sub.name, looks_like: sub.looks_like || null, on_deck: false, sort: 1000 };
          metricId = out.metric.id;
          batch.push({ table: 'metrics', row: out.metric });
        }
        const picked = [...new Set(sub.root_cause_ids)].map((rid) => snap.root_causes.find((r) => r.id === rid)!).filter(Boolean);
        let target: RootCause | undefined = picked.length === 1 ? picked[0] : undefined;
        if (sub.root_cause) {
          target = snap.root_causes.find((r) => r.text.toLowerCase() === sub.root_cause.toLowerCase());
          if (!target) {
            target = { ...community(), text: sub.root_cause };
            batch.push({ table: 'root_causes', row: target });
          }
          if (!picked.includes(target)) picked.push(target);
        }
        out.root_causes = picked;
        for (const rc of picked) {
          if (snap.metric_causes.some((l) => l.metric_id === metricId && l.root_cause_id === rc.id)) continue;
          const link: MetricCause = { ...community(), metric_id: metricId, root_cause_id: rc.id };
          out.links!.push(link);
          batch.push({ table: 'metric_causes', row: link });
        }
        if (sub.type === 'cause' && !out.links!.length && !sub.remediations.length) {
          throw new Error('Those root causes are already listed under this signal');
        }
        for (const r of sub.remediations) {
          if (snap.remediations.some((x) => x.root_cause_id === target!.id && x.lens === r.lens && x.text === r.text)) continue;
          const row: Remediation = { ...community(), root_cause_id: target!.id, lens: r.lens, text: r.text };
          out.remediations.push(row);
          batch.push({ table: 'remediations', row });
        }
      }

      batch.forEach(apply);
      store([...readStored(), ...batch]);
      bc?.postMessage(batch);
      return out;
    },
  };
}
