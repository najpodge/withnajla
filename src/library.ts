import { LENSES, LENS_LABEL } from './content';
import type { Store } from './store';
import type { Lens, Remediation, RootCause, SectionId, StuckPoint } from './types';
import { ago, esc, hl, matches } from './util';

export interface Filter {
  section: SectionId | null;
  q: string;
}

export interface VisibleRow {
  sp: StuckPoint;
  causes: { rc: RootCause; rems: Remediation[] }[];
}

const FLASH_MS = 4000;

export function visibleRows(store: Store, f: Filter): VisibleRow[] {
  const q = f.q.trim();
  const out: VisibleRow[] = [];
  for (const sp of store.orderedStuckPoints()) {
    if (f.section && sp.section !== f.section) continue;
    const causes = store.rootCausesOf(sp.id).map((rc) => ({ rc, rems: store.remediationsOf(rc.id) }));
    if (!q) {
      out.push({ sp, causes });
      continue;
    }
    const spHit = [sp.code, sp.name, sp.symptom, ...sp.signals].some((t) => matches(t, q));
    const hitCauses = spHit ? causes : causes.filter(({ rc, rems }) => matches(rc.text, q) || rems.some((r) => matches(r.text, q)));
    if (spHit || hitCauses.length) out.push({ sp, causes: hitCauses });
  }
  return out;
}

function flash(store: Store, id: string): string {
  const t = store.arrivedAt.get(id);
  if (!t) return '';
  const elapsed = Date.now() - t;
  if (elapsed > FLASH_MS) {
    store.arrivedAt.delete(id);
    return '';
  }
  return ` is-new" style="animation-delay:-${elapsed}ms`;
}

export function badge(row: { source: string; created_at: string }): string {
  if (row.source === 'najla') return `<span class="badge badge-najla" title="Curated by Najla">Najla</span>`;
  return `<span class="badge badge-community">Community · <time datetime="${row.created_at}" data-ago>${ago(row.created_at)}</time></span>`;
}

const addBtn = (action: string, attrs: string, text: string, cls = 'add') =>
  `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;

function remChip(store: Store, r: Remediation, q: string) {
  return `<li class="rem rem-${r.lens}${flash(store, r.id)}" id="item-${r.id}" data-key="item-${r.id}"><span class="rem-text">${hl(r.text, q)}</span> ${badge(r)}</li>`;
}

function signalsList(sp: StuckPoint, q: string) {
  if (!sp.signals.length) return '<p class="muted small">No signals yet</p>';
  return `<ul class="signals">${sp.signals.map((s) => `<li>${hl(s, q)}</li>`).join('')}</ul>`;
}

function spHead(store: Store, sp: StuckPoint, q: string, tag: 'h3' | 'div') {
  return `<${tag} class="sp-name"><span class="code">${hl(sp.code, q)}</span><span class="dot" aria-hidden="true">·</span>${hl(sp.name, q)}</${tag}>
    <p class="symptom">${hl(sp.symptom, q)}</p>
    <p class="meta">${badge(sp)}</p>`;
}

const addRcBtn = (sp: StuckPoint) =>
  addBtn('add-rc', `data-sp="${sp.id}" data-key="add-rc-${sp.id}"`, '+ Add a root cause');
const addRemBtn = (rc: RootCause, lens?: Lens, label = '+ Add a remediation', cls = 'add') =>
  addBtn(
    'add-rem',
    `data-rc="${rc.id}"${lens ? ` data-lens="${lens}" aria-label="Add a ${LENS_LABEL[lens]} remediation"` : ''} data-key="add-rem-${rc.id}-${lens ?? ''}"`,
    label,
    cls,
  );

// ---------------------------------------------------------------------------
// Desktop: table
// ---------------------------------------------------------------------------

export function renderTable(store: Store, rows: VisibleRow[], q: string): string {
  const body = rows
    .map(({ sp, causes }) => {
      const n = Math.max(causes.length, 1);
      const spCells = `
        <th scope="rowgroup" rowspan="${n}" class="c-sp">
          ${spHead(store, sp, q, 'div')}
          ${addRcBtn(sp)}
        </th>
        <td rowspan="${n}" class="c-sig">${signalsList(sp, q)}</td>`;
      if (!causes.length) {
        return `<tbody class="sp${flash(store, sp.id)}" id="item-${sp.id}"><tr>${spCells}<td colspan="4" class="muted small">No root causes match.</td></tr></tbody>`;
      }
      const trs = causes
        .map(({ rc, rems }, i) => {
          const lensCells = LENSES.map((lens) => {
            const mine = rems.filter((r) => r.lens === lens);
            return `<td class="c-lens c-${lens}">${
              mine.length
                ? `<ul class="rems">${mine.map((r) => remChip(store, r, q)).join('')}</ul>`
                : addRemBtn(rc, lens, '+ add', 'add add-empty')
            }</td>`;
          }).join('');
          return `<tr class="rc-row">
            ${i === 0 ? spCells : ''}
            <td class="c-rc${flash(store, rc.id)}" id="item-${rc.id}">
              <p class="rc-text">${hl(rc.text, q)}</p>
              <p class="meta">${badge(rc)}</p>
              ${addRemBtn(rc)}
            </td>
            ${lensCells}
          </tr>`;
        })
        .join('');
      return `<tbody class="sp${flash(store, sp.id)}" id="item-${sp.id}">${trs}</tbody>`;
    })
    .join('');

  return `<table class="lib">
    <caption class="sr-only">Where flow gets stuck, with signals, root causes and People, Process and Tech remediations</caption>
    <colgroup><col class="w-sp"><col class="w-sig"><col class="w-rc"><col class="w-lens"><col class="w-lens"><col class="w-lens"></colgroup>
    <thead><tr>
      <th scope="col">Where flow gets stuck</th>
      <th scope="col">Signals that show it</th>
      <th scope="col">Root cause</th>
      <th scope="col" class="h-people">People</th>
      <th scope="col" class="h-process">Process</th>
      <th scope="col" class="h-tech">Tech</th>
    </tr></thead>
    ${body}
  </table>`;
}

// ---------------------------------------------------------------------------
// Mobile: cards
// ---------------------------------------------------------------------------

export function renderCards(store: Store, rows: VisibleRow[], q: string): string {
  return rows
    .map(({ sp, causes }) => {
      const rcs = causes
        .map(({ rc, rems }) => {
          const lenses = LENSES.map((lens) => {
            const mine = rems.filter((r) => r.lens === lens);
            return `<div class="lens-row">
              <span class="tag tag-${lens}">${LENS_LABEL[lens]}</span>
              ${mine.length ? `<ul class="rems">${mine.map((r) => remChip(store, r, q)).join('')}</ul>` : addRemBtn(rc, lens, '+ add', 'add add-empty')}
            </div>`;
          }).join('');
          return `<section class="rc${flash(store, rc.id)}" id="item-${rc.id}">
            <p class="k">Root cause</p>
            <p class="rc-text">${hl(rc.text, q)}</p>
            <p class="meta">${badge(rc)}</p>
            <div class="lenses">${lenses}</div>
            ${addRemBtn(rc)}
          </section>`;
        })
        .join('');
      return `<article class="card sp${flash(store, sp.id)}" id="item-${sp.id}">
        ${spHead(store, sp, q, 'h3')}
        <details class="sig-details"${q && sp.signals.some((s) => matches(s, q)) ? ' open' : ''}>
          <summary>Signals that show it <span class="muted">(${sp.signals.length})</span></summary>
          ${signalsList(sp, q)}
        </details>
        ${rcs || '<p class="muted small">No root causes match.</p>'}
        <div class="card-foot">${addRcBtn(sp)}</div>
      </article>`;
    })
    .join('');
}

export function countLabel(rows: VisibleRow[]): string {
  const sp = rows.length;
  const rc = rows.reduce((n, r) => n + r.causes.length, 0);
  return `${sp} stuck point${sp === 1 ? '' : 's'} · ${rc} root cause${rc === 1 ? '' : 's'}`;
}

export function emptyState(f: Filter): string {
  return `<div class="empty">
    <p class="empty-title">Nothing matches${f.q ? ` “${esc(f.q)}”` : ''}${f.section ? ` in section ${f.section}` : ''}.</p>
    <p>Seen it on your team? Add it to the library.</p>
    <button type="button" class="btn" data-action="add-sp" data-prefill="query">+ Add a new stuck point</button>
  </div>`;
}
