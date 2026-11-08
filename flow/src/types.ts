export type Source = 'najla' | 'community';
export type Lens = 'people' | 'process' | 'tech';
export type SectionId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

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

export interface StuckPoint extends Row {
  section: SectionId;
  code: string;
  name: string;
  symptom: string;
  signals: string[];
}

export interface RootCause extends Row {
  stuck_point_id: string;
  text: string;
}

export interface Remediation extends Row {
  root_cause_id: string;
  lens: Lens;
  text: string;
}

/** A signal added to an existing stuck point after it was created. */
export interface Signal extends Row {
  stuck_point_id: string;
  text: string;
}

export type TableName = 'stuck_points' | 'root_causes' | 'remediations' | 'signals';

export interface Snapshot {
  sections: Section[];
  stuck_points: StuckPoint[];
  root_causes: RootCause[];
  remediations: Remediation[];
  signals: Signal[];
}

export interface RemediationInput {
  lens: Lens;
  text: string;
}

export type Submission =
  | { type: 'signal'; stuck_point_id: string; signals: string[] }
  | { type: 'remediation'; root_cause_id: string; remediations: RemediationInput[] }
  | { type: 'root_cause'; stuck_point_id: string; root_cause: string; remediations: RemediationInput[] }
  | {
      type: 'stuck_point';
      section: SectionId;
      name: string;
      symptom: string;
      signals: string[];
      root_cause: string;
      remediations: RemediationInput[];
    };

export interface SubmitResult {
  stuck_point: StuckPoint | null;
  root_cause: RootCause | null;
  remediations: Remediation[];
  signals: Signal[];
}

export type ChangeEvent =
  | { kind: 'upsert'; table: TableName; row: StuckPoint | RootCause | Remediation | Signal }
  | { kind: 'remove'; table: TableName; id: string }
  | { kind: 'resync' };
