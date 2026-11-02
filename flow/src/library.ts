import { LENSES, LENS_LABEL } from './content';
import type { Store } from './store';
import type { Lens, Remediation, RootCause, SectionId, Signal, StuckPoint } from './types';
import { ago, esc, hl, matches } from './util';

export interface Filter {
  section: SectionId | null;
  q: string;
}

export interface VisibleRow {
  sp: StuckPoint;
  signals: Signal[];
  causes: { rc: RootCause; rems: Remediation[] }[];
}

const FLASH_MS = 4000;

export function visibleRows(store: Store, f: Filter): VisibleRow[] {
  const q = f.q.trim();
  const out: VisibleRow[] = [];
  for (const sp of store.orderedStuckPoints()) {
    if (f.section && sp.section !== f.section) continue;
    const signals = store.addedSignalsOf(sp.id);
    const causes = store.rootCausesOf(sp.id).map((rc) => ({ rc, rems: store.remediationsOf(rc.id) }));
    if (!q) {
      out.push({ sp, signals, causes });
      continue;
    }
    const spHit = [sp.code, sp.name, sp.symptom, ...sp.signals, ...signals.map((s) => s.text)].some((t) => matches(t, q));
    const hitCauses = spHit ? causes : causes.filter(({ rc, rems }) => matches(rc.text, q) || rems.some((r) => matches(r.text, q)));
    if (spHit || hitCauses.length) out.push({ sp, signals, causes: hitCauses });
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

const meta = (row: { source: string; created_at: string }) => `<p class="meta">${badge(row)}</p>`;

const addBtn = (action: string, attrs: string, text: string, label?: string) =>
  `<button type="button" class="add" data-action="${action}" ${attrs}${label ? ` aria-label="${esc(label)}"` : ''}>${text}</button>`;

function remChip(store: Store, r: Remediation, q: string) {
  return `<li class="rem rem-${r.lens}${flash(store, r.id)}" id="item-${r.id}"><span class="rem-text">${hl(r.text, q)}</span> ${badge(r)}</li>`;
}

function signalsList(store: Store, sp: StuckPoint, added: Signal[], q: string) {
  if (!sp.signals.length && !added.length) return '';
  return `<ul class="signals">${sp.signals.map((s) => `<li>${hl(s, q)}</li>`).join('')}${added
    .map((s) => `<li class="${flash(store, s.id)}" id="item-${s.id}">${hl(s.text, q)} ${badge(s)}</li>`)
    .join('')}</ul>`;
}

function spHead(sp: StuckPoint, q: string, tag: 'h3' | 'div') {
  return `<${tag} class="sp-name"><span class="code">${hl(sp.code, q)}</span><span class="dot" aria-hidden="true">·</span>${hl(sp.name, q)}</${tag}>
    <p class="symptom">${hl(sp.symptom, q)}</p>
    ${meta(sp)}`;
}

const addSignalBtn = (sp: StuckPoint) =>
  addBtn('add-signal', `data-sp="${sp.id}" data-key="add-sig-${sp.id}"`, '+ Add a signal', `Add a signal for ${sp.code}`);
const addRcBtn = (sp: StuckPoint) =>
  addBtn('add-rc', `data-sp="${sp.id}" data-key="add-rc-${sp.id}"`, '+ Add a root cause', `Add a root cause for ${sp.code}`);
const addRemBtn = (rc: RootCause, lens: Lens) =>
  addBtn(
    'add-rem',
    `data-rc="${rc.id}" data-lens="${lens}" data-key="add-rem-${rc.id}-${lens}"`,
    '+ Add',
    `Add a ${LENS_LABEL[lens]} remediation for: ${rc.text}`,
  );

function lensContent(store: Store, rc: RootCause, rems: Remediation[], lens: Lens, q: string) {
  const mine = rems.filter((r) => r.lens === lens);
  return `${mine.length ? `<ul class="rems">${mine.map((r) => remChip(store, r, q)).join('')}</ul>` : ''}${addRemBtn(rc, lens)}`;
}

// ---------------------------------------------------------------------------
// Desktop: table
// ---------------------------------------------------------------------------

export function renderTable(store: Store, rows: VisibleRow[], q: string): string {
  const body = rows
    .map(({ sp, signals, causes }) => {
      const n = Math.max(causes.length, 1);
      const spCell = `<th scope="rowgroup" rowspan="${n + 1}" class="c-sp">${spHead(sp, q, 'div')}</th>`;
      const sigCell = `<td rowspan="${n}" class="c-sig">${signalsList(store, sp, signals, q)}</td>`;
      const trs = causes.length
        ? causes
            .map(
              ({ rc, rems }, i) => `<tr class="rc-row">
            ${i === 0 ? spCell + sigCell : ''}
            <td class="c-rc${flash(store, rc.id)}" id="item-${rc.id}">
              <p class="rc-text">${hl(rc.text, q)}</p>
              ${meta(rc)}
            </td>
            ${LENSES.map((lens) => `<td class="c-lens c-${lens}">${lensContent(store, rc, rems, lens, q)}</td>`).join('')}
          </tr>`,
            )
            .join('')
        : `<tr>${spCell}${sigCell}<td colspan="4" class="muted small">No root causes match.</td></tr>`;
      const addRow = `<tr class="add-row">
          <td class="c-sig">${addSignalBtn(sp)}</td>
          <td class="c-rc">${addRcBtn(sp)}</td>
          <td colspan="3"></td>
        </tr>`;
      return `<tbody class="sp${flash(store, sp.id)}" id="item-${sp.id}">${trs}${addRow}</tbody>`;
    })
    .join('');

  return `<table class="lib">
    <caption class="sr-only">Where flow gets stuck, with signals, root causes and People, Process and Tech remediations</caption>
    <colgroup><col class="w-sp"><col class="w-sig"><col class="w-rc"><col class="w-lens"><col class="w-lens"><col class="w-lens"></colgroup>
    <thead>
      <tr class="group-row">
        <th scope="colgroup" colspan="3" class="g-diag">Diagnosis</th>
        <th scope="colgroup" colspan="3" class="g-rem">Remediation</th>
      </tr>
      <tr>
        <th scope="col">Where flow gets stuck</th>
        <th scope="col">Signals that show it</th>
        <th scope="col">Root cause</th>
        <th scope="col" class="h-people">People</th>
        <th scope="col" class="h-process">Process</th>
        <th scope="col" class="h-tech">Tech</th>
      </tr>
    </thead>
    ${body}
  </table>`;
}

// ---------------------------------------------------------------------------
// Mobile: cards
// ---------------------------------------------------------------------------

export function renderCards(store: Store, rows: VisibleRow[], q: string): string {
  return rows
    .map(({ sp, signals, causes }) => {
      const sigCount = sp.signals.length + signals.length;
      const sigHit = q && [...sp.signals, ...signals.map((s) => s.text)].some((s) => matches(s, q));
      const rcs = causes
        .map(
          ({ rc, rems }) => `<section class="rc${flash(store, rc.id)}" id="item-${rc.id}">
            <p class="k">Root cause</p>
            <p class="rc-text">${hl(rc.text, q)}</p>
            ${meta(rc)}
            <p class="k rem-k">Remediation</p>
            <div class="lenses">${LENSES.map(
              (lens) => `<div class="lens-row">
                <span class="tag tag-${lens}">${LENS_LABEL[lens]}</span>
                <div class="lens-body">${lensContent(store, rc, rems, lens, q)}</div>
              </div>`,
            ).join('')}</div>
          </section>`,
        )
        .join('');
      return `<article class="card sp${flash(store, sp.id)}" id="item-${sp.id}">
        ${spHead(sp, q, 'h3')}
        <details class="sig-details"${sigHit ? ' open' : ''}>
          <summary>Signals that show it <span class="muted">(${sigCount})</span></summary>
          ${signalsList(store, sp, signals, q)}
          ${addSignalBtn(sp)}
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
