import { LIMITS, LENSES } from './content';
import type { Submission } from './types';

/** Mirrors the database rules. Returns an error message, or null when valid. */
export function validateSubmission(sub: Submission): string | null {
  const field = (v: string, label: string, max: number) => {
    const t = v.trim();
    if (!t) return `${label} is required`;
    if (t.length > max) return `${label} must be ${max} characters or fewer`;
    return null;
  };

  if (sub.type === 'signal') {
    const sigs = sub.signals.map((s) => s.trim()).filter(Boolean);
    if (!sigs.length) return 'Add at least one signal';
    if (sigs.length > LIMITS.signals) return `At most ${LIMITS.signals} signals at a time`;
    for (const s of sigs) if (s.length > LIMITS.signal) return `Each signal must be ${LIMITS.signal} characters or fewer`;
    return null;
  }
  if (sub.type === 'stuck_point') {
    if (!/^[A-G]$/.test(sub.section)) return 'Pick a section A–G';
    const e = field(sub.name, 'Name', LIMITS.name) ?? field(sub.symptom, 'Symptom', LIMITS.symptom);
    if (e) return e;
    const sigs = sub.signals.map((s) => s.trim()).filter(Boolean);
    if (sigs.length > LIMITS.signals) return `At most ${LIMITS.signals} signals`;
    for (const s of sigs) if (s.length > LIMITS.signal) return `Each signal must be ${LIMITS.signal} characters or fewer`;
  }
  if (sub.type === 'stuck_point' || sub.type === 'root_cause') {
    const e = field(sub.root_cause, 'Root cause', LIMITS.text);
    if (e) return e;
  }
  if (sub.remediations.length === 0) return 'Add at least one remediation';
  if (sub.remediations.length > LIMITS.remediations) return `At most ${LIMITS.remediations} remediations at a time`;
  for (const r of sub.remediations) {
    if (!LENSES.includes(r.lens)) return 'Each remediation needs a lens: People, Process or Tech';
    const e = field(r.text, 'Remediation', LIMITS.text);
    if (e) return e;
  }
  return null;
}

/** Trim everything and drop empty signals before sending. */
export function normalize(sub: Submission): Submission {
  if (sub.type === 'signal') return { ...sub, signals: sub.signals.map((s) => s.trim()).filter(Boolean) };
  const remediations = sub.remediations.map((r) => ({ lens: r.lens, text: r.text.trim() }));
  if (sub.type === 'stuck_point') {
    return {
      ...sub,
      name: sub.name.trim(),
      symptom: sub.symptom.trim(),
      root_cause: sub.root_cause.trim(),
      signals: sub.signals.map((s) => s.trim()).filter(Boolean),
      remediations,
    };
  }
  if (sub.type === 'root_cause') return { ...sub, root_cause: sub.root_cause.trim(), remediations };
  return { ...sub, remediations };
}
