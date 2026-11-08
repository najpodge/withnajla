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

  /** Root causes whose text contains the query, for "link an existing one". */
  findRootCauses(q: string, limit = 6): RootCause[] {
    const needle = q.trim().toLowerCase();
    if (needle.length < 3) return [];
    const words = needle.split(/\s+/).filter((w) => w.length > 2);
    const score = (t: string) => {
      const h = t.toLowerCase();
      if (h.includes(needle)) return 2;
      return words.length && words.every((w) => h.includes(w)) ? 1 : 0;
    };
    return [...this.rootCauses.values()]
      .map((rc) => ({ rc, s: score(rc.text) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.rc.text.length - b.rc.text.length)
      .slice(0, limit)
      .map((x) => x.rc);
  }
}

function byTime(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}
