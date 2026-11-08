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
  const optional = (v: string, label: string, max: number) =>
    v.trim().length > max ? `${label} must be ${max} characters or fewer` : null;

  if (sub.type === 'metric') {
    if (!/^[A-G]$/.test(sub.section)) return 'Pick a section A–G';
    if (sub.arrow !== 'up' && sub.arrow !== 'down') return 'Pick whether it should go up or down';
    const e = field(sub.name, 'Signal', LIMITS.signal) ?? optional(sub.looks_like, 'When it goes wrong', LIMITS.text);
    if (e) return e;
  }
  if (sub.type !== 'remediation') {
    const e = optional(sub.root_cause, 'Root cause', LIMITS.text);
    if (e) return e;
    const hasNew = !!sub.root_cause.trim();
    if (sub.type === 'cause' && !hasNew && !sub.root_cause_ids.length) return 'Pick or write at least one root cause';
    if (sub.root_cause_ids.length > 20) return 'Pick at most 20 root causes at a time';
    if (sub.remediations.length && !hasNew && sub.root_cause_ids.length !== 1) {
      return 'Remediations need a single root cause: write a new one, or pick just one';
    }
  }
  if (sub.type === 'remediation' && sub.remediations.length === 0) return 'Add at least one remediation';
  if (sub.remediations.length > LIMITS.remediations) return `At most ${LIMITS.remediations} remediations at a time`;
  for (const r of sub.remediations) {
    if (!LENSES.includes(r.lens)) return 'Each remediation needs a lens: People, Process or Tech';
    const e = field(r.text, 'Remediation', LIMITS.text);
    if (e) return e;
  }
  return null;
}

/** Trim everything before sending. */
export function normalize(sub: Submission): Submission {
  const remediations = sub.remediations.map((r) => ({ lens: r.lens, text: r.text.trim() }));
  if (sub.type === 'metric') {
    return {
      ...sub,
      name: sub.name.trim(),
      looks_like: sub.looks_like.trim(),
      root_cause: sub.root_cause.trim(),
      remediations,
    };
  }
  if (sub.type === 'cause') return { ...sub, root_cause: sub.root_cause.trim(), remediations };
  return { ...sub, remediations };
}
