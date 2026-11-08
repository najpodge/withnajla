import { LENSES, LENS_LABEL, SHORT_NAME } from './content';
import type { Store } from './store';
import type { Lens, Metric, MetricCause, Remediation, RootCause, SectionId } from './types';
import { ago, esc, hl, matches } from './util';

export interface Filter {
  section: SectionId | null;
  q: string;
}

export interface Cause {
  rc: RootCause;
  link: MetricCause;
  rems: Remediation[];
}

export interface VisibleRow {
  m: Metric;
  causes: Cause[];
}

/** Which signal and root cause are open in the phone step flow. */
export interface PhoneState {
  metricId: string | null;
  rcId: string | null;
}

const FLASH_MS = 4000;

export function visibleRows(store: Store, f: Filter): VisibleRow[] {
  const q = f.q.trim();
  const out: VisibleRow[] = [];
  for (const m of store.orderedMetrics()) {
    if (f.section && m.section !== f.section) continue;
    const causes = store.causesOf(m.id).map(({ rc, link }) => ({ rc, link, rems: store.remediationsOf(rc.id) }));
    if (!q) {
      out.push({ m, causes });
      continue;
    }
    const hit = [m.name, m.looks_like ?? ''].some((t) => matches(t, q));
    const hitCauses = hit ? causes : causes.filter(({ rc, rems }) => matches(rc.text, q) || rems.some((r) => matches(r.text, q)));
    if (hit || hitCauses.length) out.push({ m, causes: hitCauses });
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

type Authored = { source: string; author?: string | null; created_at: string };

// Curated rows carry no tag; community rows show who (a random name) and when.
export function badge(row: Authored): string {
  if (row.source === 'najla') return '';
  return `<span class="badge badge-community" title="Added by the community">${esc(row.author || 'Community')} · <time datetime="${row.created_at}" data-ago>${ago(row.created_at)}</time></span>`;
}

const meta = (row: Authored) => (row.source === 'najla' ? '' : `<p class="meta">${badge(row)}</p>`);

const addBtn = (action: string, attrs: string, text: string, label?: string) =>
  `<button type="button" class="add" data-action="${action}" ${attrs}${label ? ` aria-label="${esc(label)}"` : ''}>${text}</button>`;

export const arrowHtml = (m: Metric) =>
  `<span class="arrow arrow-${m.arrow}" aria-label="should go ${m.arrow}" title="Flow improves when this goes ${m.arrow}">${m.arrow === 'up' ? '↑' : '↓'}</span>`;

const deckMark = (m: Metric) => (m.on_deck ? `<span class="deck" title="This signal is on the workshop slides">From the talk</span>` : '');

function metricHead(m: Metric, q: string, tag: 'div' | 'h3' = 'div') {
  return `<${tag} class="sig-name">${arrowHtml(m)}<span>${hl(m.name, q)}</span></${tag}>
    ${m.looks_like ? `<p class="looks"><span class="looks-k">When it goes wrong:</span> ${hl(m.looks_like, q)}</p>` : ''}
    ${m.on_deck || m.source !== 'najla' ? `<p class="meta">${deckMark(m)}${badge(m)}</p>` : ''}`;
}

/** "Also under" links to the other signals a root cause sits under. */
function alsoUnder(store: Store, rc: RootCause, here: string) {
  const others = store.metricsOf(rc.id).filter((m) => m.id !== here);
  if (!others.length) return '';
  const shown = others.slice(0, 3);
  const rest = others.length - shown.length;
  return `<p class="also">Also under ${shown
    .map((m) => `<button type="button" class="also-link" data-action="goto-metric" data-metric="${m.id}">${m.section} · ${esc(m.name)}</button>`)
    .join(', ')}${rest ? ` and ${rest} more` : ''}</p>`;
}

const addMetricBtn = (section: SectionId) =>
  addBtn('add-metric', `data-section="${section}" data-key="add-metric-${section}"`, `+ Add a signal to ${section}`, `Add a signal to ${section}, ${SHORT_NAME[section]}`);
const addCauseBtn = (m: Metric) =>
  addBtn('add-cause', `data-metric="${m.id}" data-key="add-cause-${m.id}"`, '+ Add a root cause', `Add a root cause for ${m.name}`);
const addRemBtn = (rc: RootCause, lens: Lens, where: string) =>
  addBtn(
    'add-rem',
    `data-rc="${rc.id}" data-lens="${lens}" data-key="add-rem-${where}-${rc.id}-${lens}"`,
    '+ Add',
    `Add a ${LENS_LABEL[lens]} remediation for: ${rc.text}`,
  );

function remChip(store: Store, r: Remediation, q: string) {
  return `<li class="rem rem-${r.lens}${flash(store, r.id)}" data-item="${r.id}"><span class="rem-text">${hl(r.text, q)}</span>${r.source === 'najla' ? '' : ' ' + badge(r)}</li>`;
}

function lensContent(store: Store, rc: RootCause, rems: Remediation[], lens: Lens, q: string, where: string) {
  const mine = rems.filter((r) => r.lens === lens);
  return `${mine.length ? `<ul class="rems">${mine.map((r) => remChip(store, r, q)).join('')}</ul>` : ''}${addRemBtn(rc, lens, where)}`;
}

function bySection(store: Store, rows: VisibleRow[]) {
  return store.sections
    .map((s) => ({ s, rows: rows.filter((r) => r.m.section === s.id) }))
    .filter((g) => g.rows.length);
}

// ---------------------------------------------------------------------------
// Desktop: table, grouped by section, one row group per signal
// ---------------------------------------------------------------------------

export function renderTable(store: Store, rows: VisibleRow[], q: string): string {
  const body = bySection(store, rows)
    .map(({ s, rows }) => {
      const head = `<tbody class="sec-group"><tr class="sec-row"><th colspan="5" scope="colgroup">
          <span class="sec-row-in"><span class="letter" aria-hidden="true">${s.id}</span><span>${esc(s.name)}</span>${addMetricBtn(s.id)}</span>
        </th></tr></tbody>`;
      const sigs = rows
        .map(({ m, causes }) => {
          const n = causes.length;
          const sigCell = `<th scope="rowgroup" rowspan="${n + 1}" class="c-sig">${metricHead(m, q)}</th>`;
          const trs = n
            ? causes
                .map(
                  ({ rc, link, rems }, i) => `<tr class="rc-row">
                ${i === 0 ? sigCell : ''}
                <td class="c-rc${flash(store, link.id)}" data-item="${link.id}">
                  <p class="rc-text">${hl(rc.text, q)}</p>
                  ${meta(rc)}
                  ${alsoUnder(store, rc, m.id)}
                </td>
                ${LENSES.map((lens) => `<td class="c-lens c-${lens}">${lensContent(store, rc, rems, lens, q, m.id)}</td>`).join('')}
              </tr>`,
                )
                .join('')
            : '';
          const addRow = `<tr class="add-row">${n ? '' : sigCell}
              <td class="c-rc">${n ? '' : '<p class="muted small">No root causes yet.</p>'}${addCauseBtn(m)}</td>
              <td colspan="3"></td>
            </tr>`;
          return `<tbody class="sig${flash(store, m.id)}" data-item="${m.id}">${trs}${addRow}</tbody>`;
        })
        .join('');
      return head + sigs;
    })
    .join('');

  return `<table class="lib">
    <caption class="sr-only">Signals by section, the root causes behind them, and People, Process and Tech remediations</caption>
    <colgroup><col class="w-sig"><col class="w-rc"><col class="w-lens"><col class="w-lens"><col class="w-lens"></colgroup>
    <thead>
      <tr class="group-row">
        <th scope="colgroup" colspan="2" class="g-diag">Diagnosis</th>
        <th scope="colgroup" colspan="3" class="g-rem">Remediation</th>
      </tr>
      <tr>
        <th scope="col">Signal</th>
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
// Phones: section → signal → root cause → remediations, one step at a time
// ---------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function renderPhone(store: Store, rows: VisibleRow[], q: string, state: PhoneState): string {
  const m = state.metricId ? store.metrics.get(state.metricId) : undefined;
  const rc = m && state.rcId ? store.rootCauses.get(state.rcId) : undefined;

  if (m && rc) {
    const rems = store.remediationsOf(rc.id);
    return `<div class="phone">
      <button type="button" class="ph-back" data-action="phone-back">← ${esc(m.name)}</button>
      <article class="card">
        <p class="k">Root cause</p>
        <h3 class="ph-title">${esc(rc.text)}</h3>
        ${meta(rc)}
        ${alsoUnder(store, rc, m.id)}
        <p class="k rem-k">Remediation</p>
        <div class="lenses">${LENSES.map(
          (lens) => `<div class="lens-row">
            <span class="tag tag-${lens}">${LENS_LABEL[lens]}</span>
            <div class="lens-body">${lensContent(store, rc, rems, lens, '', 'ph')}</div>
          </div>`,
        ).join('')}</div>
      </article>
    </div>`;
  }

  if (m) {
    const causes = store.causesOf(m.id);
    return `<div class="phone">
      <button type="button" class="ph-back" data-action="phone-back">← All signals</button>
      <article class="card">
        <p class="k"><span class="letter" aria-hidden="true">${m.section}</span> ${esc(store.section(m.section).name)}</p>
        ${metricHead(m, '', 'h3')}
      </article>
      <p class="ph-step">What's causing it?</p>
      <ul class="ph-list">${causes
        .map(({ rc, link }) => {
          const n = store.remediationsOf(rc.id).length;
          return `<li><button type="button" class="ph-item${flash(store, link.id)}" data-item="${link.id}" data-action="open-cause" data-rc="${rc.id}">
            <span class="ph-item-text">${esc(rc.text)}</span>
            <span class="ph-item-sub">${plural(n, 'remediation')}${rc.source === 'najla' ? '' : ' · ' + esc(rc.author || 'Community')}</span>
            <span class="ph-chev" aria-hidden="true">›</span>
          </button></li>`;
        })
        .join('')}</ul>
      ${causes.length ? '' : '<p class="muted small">No root causes yet. Seen this on your team? Add the first one.</p>'}
      <div class="ph-foot">${addCauseBtn(m)}</div>
    </div>`;
  }

  return `<div class="phone">${bySection(store, rows)
    .map(
      ({ s, rows }) => `<section class="ph-sec">
        <h3 class="ph-sec-head"><span class="letter" aria-hidden="true">${s.id}</span>${esc(s.name)}</h3>
        <ul class="ph-list">${rows
          .map(
            ({ m, causes }) => `<li><button type="button" class="ph-item${flash(store, m.id)}" data-item="${m.id}" data-action="open-metric" data-metric="${m.id}">
              <span class="ph-item-text">${arrowHtml(m)} ${hl(m.name, q)}${m.on_deck ? ' ' + deckMark(m) : ''}</span>
              ${m.looks_like ? `<span class="ph-item-sub">${hl(m.looks_like, q)}</span>` : ''}
              <span class="ph-item-sub">${plural(causes.length, 'root cause')}</span>
              <span class="ph-chev" aria-hidden="true">›</span>
            </button></li>`,
          )
          .join('')}</ul>
        <div class="ph-foot">${addMetricBtn(s.id)}</div>
      </section>`,
    )
    .join('')}</div>`;
}

export function countLabel(rows: VisibleRow[]): string {
  const sig = rows.length;
  const rc = new Set(rows.flatMap((r) => r.causes.map((c) => c.rc.id))).size;
  return `${sig} signal${sig === 1 ? '' : 's'} · ${rc} root cause${rc === 1 ? '' : 's'}`;
}

export function emptyState(f: Filter): string {
  return `<div class="empty">
    <p class="empty-title">Nothing matches${f.q ? ` “${esc(f.q)}”` : ''}${f.section ? ` in section ${f.section}` : ''}.</p>
    <p>That might be one nobody has named yet. If you've seen it on your team, add it. It shows up for everyone right away.</p>
    <button type="button" class="btn" data-action="add-metric" data-section="${f.section ?? ''}" data-prefill="query">+ Add a signal</button>
  </div>`;
}
