import seed from './data/seed.json';

export const content = seed.content;

/** Plain-language groups for scanning root causes; community ones have none. */
export const THEMES: string[] = seed.themes;
const themeByText = new Map(seed.root_causes.map((r) => [r.text.toLowerCase(), r.theme]));
export const themeOf = (text: string): string | undefined => themeByText.get(text.toLowerCase());
export const LENSES = ['people', 'process', 'tech'] as const;
export const LENS_LABEL = { people: 'People', process: 'Process', tech: 'Tech' } as const;

export const LIMITS = {
  name: 80,
  symptom: 200,
  text: 200,
  signal: 80,
  signals: 6,
  remediations: 10,
} as const;

export const SHORT_NAME: Record<string, string> = {
  A: 'Human nodes',
  B: 'Agent nodes',
  C: 'Human ↔ human',
  D: 'Human ↔ agent',
  E: 'Agent ↔ agent',
  F: 'System',
  G: 'Sink',
};
