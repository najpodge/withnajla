import './styles.css';
import { createBackend } from './backend';
import { content, LENS_LABEL, LENSES, SHORT_NAME } from './content';
import { diagramSvg, glyph, highlightDiagram } from './diagram';
import { setupForms, type FormContext } from './forms';
import { countLabel, emptyState, renderPhone, renderTable, visibleRows, type Filter, type PhoneState } from './library';
import { Store } from './store';
import type { Lens, SectionId, SubmitResult } from './types';
import { ago, esc, prefersReducedMotion, splitSignal } from './util';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const desktop = window.matchMedia('(min-width: 960px)');

const store = new Store();
const filter: Filter = { section: null, q: '' };
const phone: PhoneState = { metricId: null, rcId: null };

// ---------------------------------------------------------------------------
// Static copy
// ---------------------------------------------------------------------------

function renderStatic() {
  $('[data-tagline]').textContent = content.tagline;

  const d = content.definitions;
  $('[data-primer-body]').innerHTML = `
    <p class="key-line">Output is the work moving along the edges. <strong>Flow is what reaches the sink.</strong></p>
    <div class="primer-cols">
      <div>
        <h3 class="k">Legend</h3>
        <ul class="legend">
          <li>${glyph.human}<span>Human node</span></li>
          <li>${glyph.agent}<span>Agent node</span></li>
          <li>${glyph.solid}<span>Human ↔ human</span></li>
          <li>${glyph.dashed}<span>Human ↔ agent</span></li>
          <li>${glyph.dotted}<span>Agent ↔ agent</span></li>
          <li>${glyph.source}<span>Source</span></li>
          <li>${glyph.sink}<span>Sink</span></li>
        </ul>
      </div>
      <div>
        <h3 class="k">Definitions</h3>
        <dl class="defs">
          ${(['node', 'edge', 'source', 'sink', 'output', 'flow'] as const)
            .map((k) => `<div><dt>${k[0].toUpperCase() + k.slice(1)}</dt><dd>${esc(d[k])}</dd></div>`)
            .join('')}
        </dl>
      </div>
      <div>
        <h3 class="k">Remediation lenses</h3>
        <dl class="lens-defs">
          ${LENSES.map((l) => `<div><dt><span class="tag tag-${l}">${LENS_LABEL[l]}</span></dt><dd>${esc(content.lenses[l])}</dd></div>`).join('')}
        </dl>
      </div>
    </div>`;

  const primer = $<HTMLDetailsElement>('[data-primer]');
  primer.open = desktop.matches;

  $('[data-library-note]').textContent = content.library_note;

  const ex = content.worked_example;
  const sec = (id: string) =>
    `<span class="letter" aria-hidden="true">${id}</span><span class="sr-only">Section ${id}, ${esc(SHORT_NAME[id] ?? '')}: </span>`;
  $('[data-example]').innerHTML = `
    <article class="example">
      <p class="k">Worked example</p>
      <h2>${esc(ex.title.replace(/^Example:\s*/, '').replace(/^./, (c) => c.toUpperCase()))}</h2>
      <p class="example-setup">${esc(ex.setup)}</p>
      <dl class="example-grid">
        <div class="ex-signals"><dt>Signals</dt><dd>${esc(ex.signal)}</dd></div>
        <div><dt>5 whys</dt><dd><ol class="whys">${ex.five_whys
          .map(([q, a]) => `<li><strong>${esc(q)}</strong> ${esc(a)}</li>`)
          .join('')}</ol></dd></div>
        <div><dt>Where it shows up</dt><dd class="with-letter">${sec(ex.shows_up_section)}<span>${esc(ex.shows_up)}</span></dd></div>
        <div><dt>Root cause</dt><dd>${esc(ex.root_cause)}</dd></div>
        <div><dt>Remediation</dt><dd><div class="fixes">${LENSES.map(
          (l) => `<div><span class="tag tag-${l}">${LENS_LABEL[l]}</span><span>${esc(ex.fixes[l])}</span></div>`,
        ).join('')}</div></dd></div>
      </dl>
    </article>`;

  const c = content.contact;
  $('[data-footer]').innerHTML = `
    <div>
      <p class="foot-title">${esc(c.heading)}</p>
      <p class="foot-line">${esc(c.line)}</p>
      <ul class="foot-links">${c.links.map((l) => `<li><a href="${l.url}" rel="noopener">${esc(l.label)}</a></li>`).join('')}</ul>
    </div>
    <div>
      <p class="small">Contributions are anonymous and public as soon as they're submitted, and may be shown, edited or reused by Najla Elmachtoub.</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Diagram, chips, side panel
// ---------------------------------------------------------------------------

function renderChips() {
  const chip = (id: SectionId | null, label: string) =>
    `<button type="button" class="chip" data-filter="${id ?? ''}" aria-pressed="${filter.section === id}">${label}</button>`;
  $('[data-chips]').innerHTML =
    chip(null, 'All') +
    store.sections
      .map((s) => chip(s.id, `<span class="letter">${s.id}</span><span class="chip-name">${esc(SHORT_NAME[s.id] ?? s.name)}</span>`))
      .join('');
}

function renderSide() {
  const side = $('[data-side]');
  if (!filter.section) {
    side.innerHTML = `
      <p class="side-intro">Each section lists the signals to watch, the root causes behind them, and <strong>People</strong>, <strong>Process</strong> and <strong>Tech</strong> remediations.</p>
      <ul class="sec-list">${store.sections
        .map((s) => `<li><button type="button" data-filter="${s.id}"><span class="letter">${s.id}</span>${esc(s.name)}</button></li>`)
        .join('')}</ul>`;
    return;
  }
  const s = store.section(filter.section);
  side.innerHTML = `
    <div class="sec-panel">
      <p class="sec-panel-head"><span class="letter">${s.id}</span><span>${esc(s.name)}</span></p>
      <p class="sec-desc">${esc(s.description)}</p>
      <p class="k">Flow metrics to watch</p>
      <ul class="metrics">${s.signals
        .map((sig) => {
          const { arrow, label } = splitSignal(sig);
          const dir = arrow === '↑' ? 'up' : 'down';
          const m = [...store.metrics.values()].find((x) => x.section === s.id && x.name.toLowerCase() === label.toLowerCase());
          const text = m
            ? `<button type="button" class="link metric-link" data-action="goto-metric" data-metric="${m.id}">${esc(label)}</button>`
            : esc(label);
          return `<li><span class="arrow arrow-${dir}" aria-label="${arrow ? `should go ${dir}` : ''}">${arrow}</span>${text}</li>`;
        })
        .join('')}</ul>
      <button type="button" class="link" data-filter="">Show all sections</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function renderLibrary() {
  const box = $('[data-library]');
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const rows = visibleRows(store, filter);
  $('[data-count]').textContent = countLabel(rows);
  if (!rows.length) {
    box.innerHTML = emptyState(filter);
  } else {
    const q = filter.q.trim();
    box.innerHTML = desktop.matches ? renderTable(store, rows, q) : renderPhone(store, rows, q, phone);
  }
  if (focusKey) box.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function setFilter(section: SectionId | null, opts: { scroll?: boolean } = {}) {
  filter.section = section;
  phone.metricId = phone.rcId = null;
  renderChips();
  renderSide();
  highlightDiagram(document, section);
  renderLibrary();
  if (opts.scroll) $('[data-side]').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

function renderAll() {
  renderChips();
  renderSide();
  highlightDiagram(document, filter.section);
  renderLibrary();
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg: string) {
  const t = $('[data-toast]');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 3500);
}

const itemEl = (id: string) => document.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);

/** Scroll so an item's top sits just below the sticky controls and table header. */
function scrollToItem(el: HTMLElement | null) {
  if (!el) return;
  const covered = $('[data-controls]').offsetHeight + (document.querySelector<HTMLElement>('.lib thead')?.offsetHeight ?? 0);
  const top = el.getBoundingClientRect().top + window.scrollY - covered - 8;
  window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** Make a signal visible (clearing filters if needed) and bring it into view. */
function gotoMetric(id: string) {
  const m = store.metrics.get(id);
  if (!m) return;
  if (!desktop.matches) {
    phone.metricId = id;
    phone.rcId = null;
    renderLibrary();
    $('[data-library] .phone')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  if (!itemEl(id)) {
    filter.q = '';
    $<HTMLInputElement>('[data-search]').value = '';
    setFilter(filter.section && filter.section !== m.section ? m.section : filter.section);
  }
  const el = itemEl(id);
  scrollToItem(el);
  el?.classList.remove('is-target');
  void el?.offsetWidth;
  el?.classList.add('is-target');
}

function revealNew(r: SubmitResult) {
  const rows = [
    ['metrics', r.metric ? [r.metric] : []],
    ['root_causes', r.root_causes ?? []],
    ['metric_causes', r.links ?? []],
    ['remediations', r.remediations ?? []],
  ] as const;
  for (const [table, list] of rows) for (const row of list) store.apply({ kind: 'upsert', table, row });

  const link = r.links?.[0];
  const metricId = r.metric?.id ?? link?.metric_id ?? phone.metricId;
  const targetId = r.metric?.id ?? link?.id ?? r.remediations?.[0]?.id;
  if (!desktop.matches) {
    if (r.metric || link) {
      phone.metricId = metricId;
      phone.rcId = null;
    }
    renderLibrary();
  } else if (targetId && !itemEl(targetId)) {
    // The new item is outside the current filter or search: show its section.
    filter.q = '';
    $<HTMLInputElement>('[data-search]').value = '';
    setFilter(metricId ? (store.metrics.get(metricId)?.section ?? null) : null);
  }
  if (targetId) scrollToItem(itemEl(targetId));
  toast('Thanks! Your idea is live for everyone.');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  renderStatic();

  const backend = await createBackend();
  if (backend.mode === 'demo') $('[data-demo]').hidden = false;

  const forms = setupForms($<HTMLDialogElement>('[data-dialog]'), store, backend, revealNew);

  try {
    store.load(await backend.load());
  } catch (err) {
    console.error(err);
    $('[data-library]').innerHTML =
      '<p class="form-error">Could not load the library. Check your connection and reload the page.</p>';
    return;
  }

  $('[data-diagram]').innerHTML =
    diagramSvg(store.sections) + '<figcaption class="sr-only">Select a section on the map to filter the library.</figcaption>';
  renderAll();

  // Live updates: render on any change, batched to one frame.
  let queued = false;
  let flashTimer = 0;
  store.onChange(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderLibrary();
    });
    // One more pass once the flash is over, so highlights clear for good.
    clearTimeout(flashTimer);
    if (store.arrivedAt.size) flashTimer = window.setTimeout(renderLibrary, 4200);
  });

  // Keep the sticky table header just below the sticky controls.
  const controls = $('[data-controls]');
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`);
  }).observe(controls);

  const resync = async () => {
    try {
      store.load(await backend.load());
    } catch {
      /* keep what we have */
    }
  };
  backend.subscribe((e) => (e.kind === 'resync' ? resync() : store.apply(e)));

  // Phones sleep: refresh after the page has been hidden for a while.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 30_000) resync();
  });

  // Relative times tick over.
  setInterval(() => {
    document.querySelectorAll<HTMLTimeElement>('time[data-ago]').forEach((t) => (t.textContent = ago(t.dateTime)));
  }, 30_000);

  desktop.addEventListener('change', () => renderLibrary());

  // Search
  let searchTimer = 0;
  $<HTMLInputElement>('[data-search]').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = (e.target as HTMLInputElement).value;
    searchTimer = window.setTimeout(() => {
      filter.q = v;
      phone.metricId = phone.rcId = null;
      renderLibrary();
    }, 120);
  });

  // Diagram: click or keyboard
  const diagram = $('[data-diagram]');
  const pick = (g: Element | null) => {
    const id = (g as SVGGElement | null)?.dataset.section as SectionId | undefined;
    if (id) setFilter(filter.section === id ? null : id);
  };
  diagram.addEventListener('click', (e) => pick((e.target as Element).closest('.sec')));
  diagram.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick((e.target as Element).closest('.sec'));
    }
  });

  // Delegated actions anywhere on the page
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-filter], [data-action]');
    if (!el) return;
    if (el.dataset.filter !== undefined) {
      setFilter((el.dataset.filter || null) as SectionId | null);
      return;
    }
    let ctx: FormContext | null = null;
    switch (el.dataset.action) {
      case 'add-metric':
        ctx = {
          kind: 'metric',
          section: (el.dataset.section || filter.section) as SectionId | null,
          name: el.dataset.prefill === 'query' ? filter.q.trim().slice(0, 80) : '',
        };
        break;
      case 'add-cause':
        ctx = { kind: 'cause', metricId: el.dataset.metric! };
        break;
      case 'add-rem':
        ctx = { kind: 'remediation', rootCauseId: el.dataset.rc!, lens: el.dataset.lens as Lens | undefined };
        break;
      case 'goto-metric':
        gotoMetric(el.dataset.metric!);
        return;
      case 'open-metric':
      case 'open-cause':
      case 'phone-back':
        if (el.dataset.action === 'open-metric') phone.metricId = el.dataset.metric!;
        else if (el.dataset.action === 'open-cause') phone.rcId = el.dataset.rc!;
        else if (phone.rcId) phone.rcId = null;
        else phone.metricId = null;
        renderLibrary();
        $('[data-library] .phone')?.scrollIntoView({ block: 'start' });
        $<HTMLElement>('[data-library] .ph-back, [data-library] .ph-item')?.focus({ preventScroll: true });
        return;
    }
    if (ctx) forms.open(ctx, el);
  });
}

main();
