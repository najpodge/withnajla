export type Source = 'najla' | 'community';
export type Lens = 'people' | 'process' | 'tech';
export type SectionId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type Arrow = 'up' | 'down';

export interface Section {
  id: SectionId;
  name: string;
  description: string;
  signals: string[];
  sort: number;
}

interface Row {
  id: string;
  created_at: string;
  source: Source;
  author?: string | null;
  hidden?: boolean;
}

/** A signal: a measurement on one part of the network (table `metrics`). */
export interface Metric extends Row {
  section: SectionId;
  arrow: Arrow;
  name: string;
  looks_like: string | null;
  on_deck: boolean;
  sort: number;
}

/** Links a signal to a root cause that can explain it. */
export interface MetricCause extends Row {
  metric_id: string;
  root_cause_id: string;
}

export interface RootCause extends Row {
  text: string;
}

export interface Remediation extends Row {
  root_cause_id: string;
  lens: Lens;
  text: string;
}

export type TableName = 'metrics' | 'metric_causes' | 'root_causes' | 'remediations';

export interface Snapshot {
  sections: Section[];
  metrics: Metric[];
  metric_causes: MetricCause[];
  root_causes: RootCause[];
  remediations: Remediation[];
}

export interface RemediationInput {
  lens: Lens;
  text: string;
}

export type Submission =
  | {
      type: 'metric';
      section: SectionId;
      arrow: Arrow;
      name: string;
      looks_like: string;
      root_cause: string;
      remediations: RemediationInput[];
    }
  | { type: 'cause'; metric_id: string; root_cause_id?: string; root_cause?: string; remediations: RemediationInput[] }
  | { type: 'remediation'; root_cause_id: string; remediations: RemediationInput[] };

export interface SubmitResult {
  metric?: Metric | null;
  root_cause?: RootCause | null;
  link?: MetricCause | null;
  remediations: Remediation[];
}

export type ChangeEvent =
  | { kind: 'upsert'; table: TableName; row: Metric | MetricCause | RootCause | Remediation }
  | { kind: 'remove'; table: TableName; id: string }
  | { kind: 'resync' };
