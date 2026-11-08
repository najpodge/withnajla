// Random two-word names for community contributors, one per browser.
// The server only ever receives the two indexes and builds the name itself
// (public.author_name in supabase/migrations/20261108000000_authors.sql),
// so keep these lists identical to the ones there.

export const AUTHOR_ADJECTIVES = [
  'Amber', 'Bright', 'Calm', 'Clever', 'Coral', 'Curious', 'Gentle', 'Golden',
  'Hidden', 'Jade', 'Lively', 'Lucky', 'Misty', 'Nimble', 'Quiet', 'Rapid',
  'Silver', 'Steady', 'Sunny', 'Swift', 'Teal', 'Velvet', 'Wild', 'Wise',
];
export const AUTHOR_NOUNS = [
  'Badger', 'Beaver', 'Crane', 'Delta', 'Falcon', 'Fern', 'Finch', 'Fox',
  'Heron', 'Kestrel', 'Lark', 'Lynx', 'Marten', 'Meadow', 'Otter', 'Owl',
  'Pebble', 'Puffin', 'Raven', 'Reed', 'Rill', 'Salmon', 'Spring', 'Willow',
];

const KEY = 'flow.author';
let cached: [number, number] | null = null;

export function authorIndexes(): [number, number] {
  if (cached) return cached;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 24)) {
      return (cached = v as [number, number]);
    }
  } catch {
    // Storage unavailable: fall through to a name for this page load only.
  }
  const pick = () => Math.floor(Math.random() * 24);
  cached = [pick(), pick()];
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // Ignore: the name just won't survive a reload.
  }
  return cached;
}

export function myAuthorName(): string {
  const [a, n] = authorIndexes();
  return `${AUTHOR_ADJECTIVES[a]} ${AUTHOR_NOUNS[n]}`;
}
