import type { Section, SectionId } from './types';
import { esc } from './util';

// Geometry traced from the deck's library slide (1600×900 canvas).
const H = { h1: [370, 350], h2: [552, 409], h3: [370, 604], h4: [521, 570] } as const;
const A = { a1: [276, 298], a2: [466, 295], a3: [666, 350], a4: [274, 663], a5: [446, 667], a6: [623, 636] } as const;
const SRC = [222, 442] as const;
const SINK = [668, 490] as const;
type P = readonly [number, number];

const line = ([x1, y1]: P, [x2, y2]: P, cls: string) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
const human = ([x, y]: P) => `<circle cx="${x}" cy="${y}" r="29" class="n-human"/>`;
const agent = ([x, y]: P) => `<rect x="${x - 19}" y="${y - 19}" width="38" height="38" rx="6" class="n-agent"/>`;
const label = (id: SectionId, [x, y]: P) =>
  `<g class="lbl"><circle cx="${x}" cy="${y}" r="17"/><text x="${x}" y="${y}">${id}</text></g>`;

const solid: [P, P][] = [
  [SRC, H.h1], [H.h1, H.h2], [H.h1, H.h4], [H.h2, H.h4], [H.h2, SINK],
];
const system: [P, P][] = [[SRC, H.h3], [H.h3, H.h4], [H.h4, SINK]];
const dashed: [P, P][] = [
  [A.a1, H.h1], [H.h1, A.a2], [H.h2, A.a3], [H.h3, A.a4], [H.h3, A.a5], [H.h4, A.a5], [H.h4, A.a6],
];
const dotted: [P, P][] = [[A.a1, A.a2], [A.a2, A.a3], [A.a4, A.a5], [A.a5, A.a6]];

export function diagramSvg(sections: Section[]): string {
  const name = (id: SectionId) => sections.find((s) => s.id === id)?.name ?? id;
  const group = (id: SectionId, inner: string) =>
    `<g class="sec" id="sec-${id}" data-section="${id}" role="button" tabindex="0" aria-label="${esc(`Filter by ${id}: ${name(id)}`)}">${inner}</g>`;

  return `
<svg class="diagram" viewBox="182 252 540 448" aria-labelledby="dg-title dg-desc">
  <title id="dg-title">The library maps where flow gets stuck</title>
  <desc id="dg-desc">A team network. A source (pink) sends work through human nodes (yellow circles) and agent nodes (blue squares) to a sink (ringed). Solid lines join humans, dashed lines join humans and agents, dotted lines join agents. Labels mark the library sections: A human nodes, B agent nodes, C human to human edges, D human to agent edges, E agent to agent edges, F system circulation along the highlighted path, G the sink. Select a label to filter the library.</desc>
  ${group('F', `<g class="band">${system.map(([a, b]) => line(a, b, 'e-band')).join('')}</g>${system.map(([a, b]) => line(a, b, 'e-solid')).join('')}${label('F', [596, 530])}`)}
  ${group('C', `${solid.map(([a, b]) => line(a, b, 'e-solid')).join('')}${label('C', [460, 380])}`)}
  ${group('D', `${dashed.map(([a, b]) => line(a, b, 'e-dashed')).join('')}${label('D', [416, 642])}`)}
  ${group('E', `${dotted.map(([a, b]) => line(a, b, 'e-dotted')).join('')}${label('E', [536, 653])}`)}
  ${group('B', `${Object.values(A).map(agent).join('')}${label('B', [488, 275])}`)}
  ${group('A', `${Object.values(H).map(human).join('')}${label('A', [394, 326])}`)}
  <g class="src"><circle cx="${SRC[0]}" cy="${SRC[1]}" r="29" class="n-source"/></g>
  ${group('G', `<circle cx="${SINK[0]}" cy="${SINK[1]}" r="37" class="n-ring"/><circle cx="${SINK[0]}" cy="${SINK[1]}" r="29" class="n-sink"/>${label('G', [704, 462])}`)}
</svg>`;
}

/** Small inline glyphs for the primer legend. */
export const glyph = {
  human: `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" class="n-human"/></svg>`,
  agent: `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="4" class="n-agent"/></svg>`,
  source: `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" class="n-source"/></svg>`,
  sink: `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" class="n-ring"/><circle cx="16" cy="16" r="10" class="n-sink"/></svg>`,
  solid: `<svg viewBox="0 0 48 32" aria-hidden="true"><line x1="2" y1="16" x2="46" y2="16" class="e-solid"/></svg>`,
  dashed: `<svg viewBox="0 0 48 32" aria-hidden="true"><line x1="2" y1="16" x2="46" y2="16" class="e-dashed"/></svg>`,
  dotted: `<svg viewBox="0 0 48 32" aria-hidden="true"><line x1="2" y1="16" x2="46" y2="16" class="e-dotted"/></svg>`,
};

export function highlightDiagram(root: ParentNode, active: SectionId | null) {
  const svg = root.querySelector('.diagram');
  if (!svg) return;
  svg.classList.toggle('has-active', !!active);
  svg.querySelectorAll<SVGGElement>('.sec').forEach((g) => {
    const on = g.dataset.section === active;
    g.classList.toggle('is-active', on);
    g.setAttribute('aria-pressed', String(on));
  });
}
