import type { ChangeEvent, Remediation, RootCause, Section, SectionId, Snapshot, StuckPoint, TableName } from './types';

/** Normalized in-memory copy of everything visible, plus "just arrived" times. */
export class Store {
  sections: Section[] = [];
  stuckPoints = new Map<string, StuckPoint>();
  rootCauses = new Map<string, RootCause>();
  remediations = new Map<string, Remediation>();
  arrivedAt = new Map<string, number>();
  private listeners: (() => void)[] = [];

  load(s: Snapshot) {
    this.sections = [...s.sections].sort((a, b) => a.sort - b.sort);
    this.stuckPoints = new Map(s.stuck_points.filter((r) => !r.hidden).map((r) => [r.id, r]));
    this.rootCauses = new Map(s.root_causes.filter((r) => !r.hidden).map((r) => [r.id, r]));
    this.remediations = new Map(s.remediations.filter((r) => !r.hidden).map((r) => [r.id, r]));
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
      map.set(e.row.id, e.row as never);
      if (!known && fresh) this.arrivedAt.set(e.row.id, Date.now());
    }
    this.emit();
  }

  private mapFor(t: TableName) {
    return (t === 'stuck_points' ? this.stuckPoints : t === 'root_causes' ? this.rootCauses : this.remediations) as Map<
      string,
      StuckPoint | RootCause | Remediation
    >;
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

  /** Stuck points ordered by section then numeric code. */
  orderedStuckPoints(): StuckPoint[] {
    const order = new Map(this.sections.map((s) => [s.id, s.sort]));
    return [...this.stuckPoints.values()].sort(
      (a, b) =>
        (order.get(a.section) ?? 0) - (order.get(b.section) ?? 0) || +a.code.slice(1) - +b.code.slice(1),
    );
  }

  rootCausesOf(spId: string): RootCause[] {
    return [...this.rootCauses.values()].filter((r) => r.stuck_point_id === spId).sort(byTime);
  }

  remediationsOf(rcId: string): Remediation[] {
    return [...this.remediations.values()].filter((r) => r.root_cause_id === rcId).sort(byTime);
  }
}

function byTime(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}
