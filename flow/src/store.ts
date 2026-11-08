import type { ChangeEvent, Metric, MetricCause, Remediation, RootCause, Section, SectionId, Snapshot, TableName } from './types';

type AnyRow = Metric | MetricCause | RootCause | Remediation;

/** Normalized in-memory copy of everything visible, plus "just arrived" times. */
export class Store {
  sections: Section[] = [];
  metrics = new Map<string, Metric>();
  links = new Map<string, MetricCause>();
  rootCauses = new Map<string, RootCause>();
  remediations = new Map<string, Remediation>();
  arrivedAt = new Map<string, number>();
  private listeners: (() => void)[] = [];

  load(s: Snapshot) {
    const visible = <T extends { id: string; hidden?: boolean }>(rows: T[]) =>
      new Map(rows.filter((r) => !r.hidden).map((r) => [r.id, r]));
    this.sections = [...s.sections].sort((a, b) => a.sort - b.sort);
    this.metrics = visible(s.metrics);
    this.links = visible(s.metric_causes);
    this.rootCauses = visible(s.root_causes);
    this.remediations = visible(s.remediations);
    this.emit();
  }

  /** Apply a change. `fresh` marks rows that should flash as new. */
  apply(e: ChangeEvent, fresh = true) {
    if (e.kind === 'resync') return;
    const map = this.mapFor(e.table);
    if (e.kind === 'remove') {
      if (!map.delete(e.id)) return;
    } else {
      const known = map.has(e.row.id);
      map.set(e.row.id, e.row);
      if (!known && fresh) this.arrivedAt.set(e.row.id, Date.now());
    }
    this.emit();
  }

  private mapFor(t: TableName) {
    const maps = {
      metrics: this.metrics,
      metric_causes: this.links,
      root_causes: this.rootCauses,
      remediations: this.remediations,
    };
    return maps[t] as Map<string, AnyRow>;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  section(id: SectionId) {
    return this.sections.find((s) => s.id === id)!;
  }

  /** Signals ordered by section, then curated order, then arrival. */
  orderedMetrics(): Metric[] {
    const order = new Map(this.sections.map((s) => [s.id, s.sort]));
    return [...this.metrics.values()].sort(
      (a, b) => (order.get(a.section) ?? 0) - (order.get(b.section) ?? 0) || a.sort - b.sort || byTime(a, b),
    );
  }

  /** Root causes under a signal, with the link that puts them there, in link order. */
  causesOf(metricId: string): { rc: RootCause; link: MetricCause }[] {
    return [...this.links.values()]
      .filter((l) => l.metric_id === metricId && this.rootCauses.has(l.root_cause_id))
      .sort(byTime)
      .map((link) => ({ rc: this.rootCauses.get(link.root_cause_id)!, link }));
  }

  /** Every signal a root cause sits under. */
  metricsOf(rcId: string): Metric[] {
    const ids = new Set([...this.links.values()].filter((l) => l.root_cause_id === rcId).map((l) => l.metric_id));
    return this.orderedMetrics().filter((m) => ids.has(m.id));
  }

  remediationsOf(rcId: string): Remediation[] {
    return [...this.remediations.values()].filter((r) => r.root_cause_id === rcId).sort(byTime);
  }

  /**
   * Every root cause, ranked by how well it matches the query, word by word.
   * Words match after trimming common endings, so "reviewers" finds "review" and "owns" finds "owner".
   * Remediation text counts too, at half weight. No query: alphabetical.
   */
  rankRootCauses(q: string): { rc: RootCause; score: number }[] {
    const all = [...this.rootCauses.values()];
    const qWords = words(q);
    if (!qWords.length) {
      return all.map((rc) => ({ rc, score: 0 })).sort((a, b) => a.rc.text.localeCompare(b.rc.text));
    }
    const hits = (text: string) => {
      const tWords = words(text);
      return qWords.filter((w) => tWords.some((t) => t.startsWith(w) || w.startsWith(t))).length;
    };
    const needle = q.trim().toLowerCase();
    return all
      .map((rc) => {
        const remHits = Math.max(0, ...this.remediationsOf(rc.id).map((r) => hits(r.text)));
        const score = hits(rc.text) + remHits / 2 + (rc.text.toLowerCase().includes(needle) ? 2 : 0);
        return { rc, score };
      })
      .sort((a, b) => b.score - a.score || a.rc.text.localeCompare(b.rc.text));
  }
}

const STOP = new Set(
  'the and for with are not but too its that this from into than they them their have has had can cant don dont doesn get got our your was were who what when how why all any out off own one more less very just'.split(' '),
);
const stem = (w: string) => {
  const s = w.replace(/(ings?|ers?|ed|es|ly|s)$/, '');
  return s.length >= 3 ? s : w;
};
const words = (t: string) =>
  t
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);

function byTime(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}
