import seed from './data/seed.json';

export const content = seed.content;
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
