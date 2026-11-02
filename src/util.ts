export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Escape text and wrap case-insensitive matches of `q` in <mark>. */
export function hl(text: string, q: string): string {
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = '';
  let i = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, i)) {
    out += esc(text.slice(i, at)) + '<mark>' + esc(text.slice(at, at + needle.length)) + '</mark>';
    i = at + needle.length;
  }
  return out + esc(text.slice(i));
}

export function matches(text: string, q: string): boolean {
  return !q || text.toLowerCase().includes(q.toLowerCase());
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });

export function ago(iso: string): string {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s > -45) return 'just now';
  const m = Math.round(s / 60);
  if (m > -60) return rtf.format(m, 'minute');
  const h = Math.round(m / 60);
  if (h > -24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/** Split "↓ Review wait time" into its arrow and label. */
export function splitSignal(s: string): { arrow: '↑' | '↓' | ''; label: string } {
  const m = s.match(/^\s*([↑↓])\s*(.*)$/);
  return m ? { arrow: m[1] as '↑' | '↓', label: m[2] } : { arrow: '', label: s };
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
