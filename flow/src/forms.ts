import type { Backend } from './backend';
import { LENSES, LENS_LABEL, LIMITS, SHORT_NAME } from './content';
import type { Store } from './store';
import type { Arrow, Lens, RemediationInput, SectionId, Submission, SubmitResult } from './types';
import { esc } from './util';
import { normalize, validateSubmission } from './validate';
import { myAuthorName } from './authors';

export type FormContext =
  | { kind: 'metric'; section?: SectionId | null; name?: string }
  | { kind: 'cause'; metricId: string }
  | { kind: 'remediation'; rootCauseId: string; lens?: Lens };

const NOTICE =
  'Submissions are anonymous and public immediately. By submitting you agree your contribution can be shown, edited or reused by Najla Elmachtoub.';

// ---------------------------------------------------------------------------
// Turnstile (loaded only when a form first opens)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id: string): void;
      remove(id: string): void;
    };
  }
}

let turnstileReady: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  turnstileReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileReady = null;
      reject(new Error('Could not load the spam check. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return turnstileReady;
}

// Sample text shown in empty fields, drawn from the curated library.
const SAMPLE = {
  signal: 'e.g. Review wait time',
  looksLike: 'e.g. Review queues grow and approvals turn into “LGTM”',
  rootCause: 'e.g. More output arriving than reviewers can judge',
  remediation: {
    people: 'e.g. Pair juniors on reviews',
    process: 'e.g. Rotate review duty',
    tech: 'e.g. Linters and formatters in CI',
  } as Record<Lens, string>,
  remediationAny: 'Pick a lens, then e.g. “Rotate review duty”',
};

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

function textField(
  name: string,
  label: string,
  max: number,
  opts: { value?: string; multiline?: boolean; hint?: string; placeholder?: string; optional?: boolean } = {},
) {
  const id = nextId(name);
  const value = esc(opts.value ?? '');
  const ph = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
  const input = opts.multiline
    ? `<textarea id="${id}" name="${name}" rows="2" maxlength="${max + 20}" data-max="${max}" aria-describedby="${id}-c"${ph}${opts.optional ? '' : ' required'}>${value}</textarea>`
    : `<input id="${id}" name="${name}" type="text" maxlength="${max + 20}" data-max="${max}" value="${value}" aria-describedby="${id}-c"${ph} autocomplete="off"${opts.optional ? '' : ' required'}>`;
  return `<div class="field">
    <div class="field-top"><label for="${id}">${label}</label><span class="counter" id="${id}-c">0 / ${max}</span></div>
    ${opts.hint ? `<p class="hint">${opts.hint}</p>` : ''}
    ${input}
  </div>`;
}

function remRow(n: number, lens?: Lens) {
  const id = nextId('rem');
  return `<fieldset class="rem-row" data-rem>
    <legend>Remediation <span data-n>${n}</span></legend>
    <div class="lens-pick" role="radiogroup" aria-label="Lens">
      ${LENSES.map(
        (l) => `<label class="tag tag-${l} pick"><input type="radio" name="${id}-lens" value="${l}" ${l === lens ? 'checked' : ''} required><span>${LENS_LABEL[l]}</span></label>`,
      ).join('')}
    </div>
    ${textField(`${id}-text`, 'What to try', LIMITS.text, {
      multiline: true,
      placeholder: lens ? SAMPLE.remediation[lens] : SAMPLE.remediationAny,
    })}
    <button type="button" class="link remove" data-remove>Remove</button>
  </fieldset>`;
}

function rootCauseField(required: boolean) {
  return `<div class="rc-field">
    ${textField('root_cause', `Root cause${required ? '' : ' <span class="muted">(optional)</span>'}`, LIMITS.text, {
      multiline: true,
      hint: 'Why it happens. Start typing to see ones already in the library.',
      placeholder: SAMPLE.rootCause,
      optional: !required,
    })}
    <div class="suggest" data-suggest hidden></div>
    <div class="picked" data-picked hidden>
      <p>Linking the existing root cause. Its remediations come with it.</p>
      <button type="button" class="link" data-unpick>Write a new one instead</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function setupForms(
  dialog: HTMLDialogElement,
  store: Store,
  backend: Backend,
  onSuccess: (r: SubmitResult) => void,
) {
  let widgetId: string | null = null;
  let token: string | null = null;
  let tsFailed = false;
  let opener: HTMLElement | null = null;

  dialog.addEventListener('close', () => {
    if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    widgetId = null;
    token = null;
    tsFailed = false;
    document.body.classList.remove('sheet-open');
    opener?.focus();
  });
  // Click on the backdrop closes.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  function contextHtml(ctx: FormContext): { title: string; ctx: string } {
    if (ctx.kind === 'cause') {
      const m = store.metrics.get(ctx.metricId)!;
      return {
        title: 'Add a root cause',
        ctx: `<p class="ctx-title">${m.arrow === 'up' ? '↑' : '↓'} ${esc(m.name)}</p><p class="muted">${m.section} · ${esc(store.section(m.section).name)}</p>`,
      };
    }
    if (ctx.kind === 'remediation') {
      const rc = store.rootCauses.get(ctx.rootCauseId)!;
      return {
        title: 'Add a remediation',
        ctx: `<p><span class="muted">Root cause:</span> ${esc(rc.text)}</p>`,
      };
    }
    return { title: 'Add a signal', ctx: '' };
  }

  function open(ctx: FormContext, from?: HTMLElement | null) {
    opener = from ?? (document.activeElement as HTMLElement);
    const { title, ctx: ctxHtml } = contextHtml(ctx);

    let fields = '';
    if (ctx.kind === 'metric') {
      const secId = nextId('section');
      fields += `<div class="field">
        <label for="${secId}">Part of the network</label>
        <select id="${secId}" name="section" required>
          <option value="">Choose A–G</option>
          ${store.sections.map((s) => `<option value="${s.id}" ${ctx.section === s.id ? 'selected' : ''}>${s.id} · ${esc(SHORT_NAME[s.id] ?? s.name)}</option>`).join('')}
        </select>
      </div>`;
      fields += textField('name', 'Signal', LIMITS.signal, { value: ctx.name, hint: 'Something you can watch or measure', placeholder: SAMPLE.signal });
      fields += `<div class="field"><p class="label">Flow improves when it goes</p>
        <div class="arrow-pick" role="radiogroup" aria-label="Flow improves when it goes">
          <label class="tag pick"><input type="radio" name="arrow" value="down" required><span>↓ Down</span></label>
          <label class="tag pick"><input type="radio" name="arrow" value="up" required><span>↑ Up</span></label>
        </div></div>`;
      fields += textField('looks_like', 'When it goes wrong <span class="muted">(optional)</span>', LIMITS.text, {
        multiline: true,
        hint: 'What the team sees when this signal is off',
        placeholder: SAMPLE.looksLike,
        optional: true,
      });
      fields += rootCauseField(false);
    }
    if (ctx.kind === 'cause') fields += rootCauseField(true);
    const remsRequired = ctx.kind === 'remediation';

    dialog.innerHTML = `
      <form class="sheet" novalidate>
        <header class="sheet-head">
          <h2 id="sheet-title">${title}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </header>
        <div class="sheet-body">
          ${ctxHtml ? `<div class="ctx">${ctxHtml}</div>` : ''}
          ${fields}
          <div data-rems>${remsRequired ? remRow(1, ctx.kind === 'remediation' ? ctx.lens : undefined) : ''}</div>
          <button type="button" class="link" data-add-rem>${remsRequired ? '+ Add another remediation' : '+ Add a remediation <span class="muted">(optional)</span>'}</button>
          <p class="notice">You'll appear as <strong>${esc(myAuthorName())}</strong>. ${NOTICE}</p>
          <div class="turnstile" data-turnstile></div>
          <p class="form-error" role="alert" data-error></p>
        </div>
        <footer class="sheet-foot">
          <button type="button" class="btn btn-quiet" data-close>Cancel</button>
          <button type="submit" class="btn" data-submit>Submit</button>
        </footer>
      </form>`;
    dialog.setAttribute('aria-labelledby', 'sheet-title');

    const form = dialog.querySelector('form')!;
    wire(form, ctx);
    document.body.classList.add('sheet-open');
    dialog.showModal();
    const first = form.querySelector<HTMLElement>(
      ctx.kind === 'remediation'
        ? ctx.lens
          ? 'textarea'
          : 'input[type=radio]'
        : ctx.kind === 'metric' && ctx.section
          ? 'input[name=name]'
          : 'select, input[type=text], textarea',
    );
    first?.focus();

    if (backend.needsTurnstile) {
      const el = form.querySelector<HTMLElement>('[data-turnstile]')!;
      loadTurnstile()
        .then(() => {
          if (!dialog.open || !window.turnstile) return;
          widgetId = window.turnstile.render(el, {
            sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
            appearance: 'interaction-only',
            callback: (t: string) => (token = t),
            'expired-callback': () => (token = null),
            'error-callback': () => {
              token = null;
              tsFailed = true;
            },
          });
        })
        .catch((err: Error) => showError(form, err.message));
    }
  }

  // Root causes already in the library that match what's being typed.
  function suggest(form: HTMLFormElement, ctx: FormContext) {
    const box = form.querySelector<HTMLElement>('[data-suggest]');
    const ta = form.querySelector<HTMLTextAreaElement>('[name=root_cause]');
    if (!box || !ta || form.dataset.rcId) return;
    const linked = new Set(ctx.kind === 'cause' ? store.causesOf(ctx.metricId).map((c) => c.rc.id) : []);
    const found = store.findRootCauses(ta.value);
    box.hidden = !found.length;
    box.innerHTML = found.length
      ? `<p class="hint">Already in the library. Pick one to link it instead of writing a copy:</p>
        <ul>${found
          .map((rc) =>
            linked.has(rc.id)
              ? `<li><span class="sugg sugg-done">${esc(rc.text)} <span class="muted">· already under this signal</span></span></li>`
              : `<li><button type="button" class="sugg" data-pick="${rc.id}">${esc(rc.text)}</button></li>`,
          )
          .join('')}</ul>`
      : '';
  }

  function pick(form: HTMLFormElement, rcId: string) {
    const rc = store.rootCauses.get(rcId);
    const ta = form.querySelector<HTMLTextAreaElement>('[name=root_cause]');
    if (!rc || !ta) return;
    form.dataset.rcId = rcId;
    ta.value = rc.text;
    ta.readOnly = true;
    updateCounter(ta);
    form.querySelector<HTMLElement>('[data-suggest]')!.hidden = true;
    form.querySelector<HTMLElement>('[data-picked]')!.hidden = false;
    form.querySelector<HTMLElement>('[data-unpick]')!.focus();
  }

  function unpick(form: HTMLFormElement) {
    const ta = form.querySelector<HTMLTextAreaElement>('[name=root_cause]')!;
    delete form.dataset.rcId;
    ta.readOnly = false;
    ta.value = '';
    updateCounter(ta);
    form.querySelector<HTMLElement>('[data-picked]')!.hidden = true;
    ta.focus();
  }

  function wire(form: HTMLFormElement, ctx: FormContext) {
    const rems = form.querySelector<HTMLElement>('[data-rems]');
    const renumber = () => {
      if (!rems) return;
      const rows = rems.querySelectorAll('[data-rem]');
      rows.forEach((row, i) => {
        row.querySelector('[data-n]')!.textContent = String(i + 1);
        (row.querySelector('[data-remove]') as HTMLElement).hidden = ctx.kind === 'remediation' && rows.length === 1;
      });
      const add = form.querySelector('[data-add-rem]') as HTMLElement;
      add.hidden = rows.length >= LIMITS.remediations;
      if (ctx.kind !== 'remediation' && rows.length) add.innerHTML = '+ Add another remediation';
    };
    renumber();

    form.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.max) updateCounter(t);
      // Match the sample text to the lens just picked.
      if (t.type === 'radio') {
        const ta = t.closest('[data-rem]')?.querySelector('textarea');
        if (ta) ta.placeholder = SAMPLE.remediation[t.value as Lens];
      }
      if (t.name === 'root_cause') suggest(form, ctx);
      showError(form, '');
    });
    form.querySelectorAll<HTMLInputElement>('[data-max]').forEach(updateCounter);

    form.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t) return;
      if (t.hasAttribute('data-close')) dialog.close();
      if (t.hasAttribute('data-add-rem') && rems) {
        rems.insertAdjacentHTML('beforeend', remRow(rems.children.length + 1));
        renumber();
        (rems.lastElementChild!.querySelector('input[type=radio]') as HTMLElement).focus();
      }
      if (t.hasAttribute('data-remove')) {
        t.closest('[data-rem]')!.remove();
        renumber();
        (form.querySelector('[data-add-rem]') as HTMLElement).focus();
      }
      if (t.dataset.pick) pick(form, t.dataset.pick);
      if (t.hasAttribute('data-unpick')) unpick(form);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sub = collect(form, ctx);
      const missingLens = [...form.querySelectorAll('[data-rem]')].findIndex((row) => !row.querySelector('input[type=radio]:checked'));
      const err =
        missingLens >= 0 ? `Pick People, Process or Tech for remediation ${missingLens + 1}` : validateSubmission(sub);
      if (err) {
        showError(form, err);
        focusInvalid(form);
        return;
      }

      const btn = form.querySelector<HTMLButtonElement>('[data-submit]')!;
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      try {
        let t: string | null = null;
        if (backend.needsTurnstile) t = await waitForToken(() => token, () => tsFailed);
        const result = await backend.submit(normalize(sub), t);
        dialog.close();
        onSuccess(result);
      } catch (ex) {
        showError(form, (ex as Error).message);
        if (widgetId && window.turnstile) {
          token = null;
          tsFailed = false;
          window.turnstile.reset(widgetId);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
    });
  }

  return { open };
}

function collect(form: HTMLFormElement, ctx: FormContext): Submission {
  const val = (name: string) => (form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? '');
  const remediations: RemediationInput[] = [...form.querySelectorAll('[data-rem]')].map((row) => ({
    lens: ((row.querySelector('input[type=radio]:checked') as HTMLInputElement | null)?.value ?? '') as Lens,
    text: (row.querySelector('textarea') as HTMLTextAreaElement).value,
  }));
  if (ctx.kind === 'remediation') return { type: 'remediation', root_cause_id: ctx.rootCauseId, remediations };
  if (ctx.kind === 'cause') {
    const picked = form.dataset.rcId;
    return picked
      ? { type: 'cause', metric_id: ctx.metricId, root_cause_id: picked, remediations }
      : { type: 'cause', metric_id: ctx.metricId, root_cause: val('root_cause'), remediations };
  }
  return {
    type: 'metric',
    section: val('section') as SectionId,
    arrow: ((form.querySelector('input[name=arrow]:checked') as HTMLInputElement | null)?.value ?? '') as Arrow,
    name: val('name'),
    looks_like: val('looks_like'),
    root_cause: val('root_cause'),
    remediations,
  };
}

function updateCounter(el: HTMLInputElement | HTMLTextAreaElement) {
  const max = Number(el.dataset.max);
  const n = el.value.trim().length;
  const c = el.getAttribute('aria-describedby') ? document.getElementById(el.getAttribute('aria-describedby')!) : null;
  if (c) {
    c.textContent = `${n} / ${max}`;
    c.classList.toggle('over', n > max);
  }
  el.setAttribute('aria-invalid', String(n > max));
}

function focusInvalid(form: HTMLFormElement) {
  const bad = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('select, input[type=text][required], textarea, [aria-invalid=true]')].find(
    (el) => el.getAttribute('aria-invalid') === 'true' || (el.required && !el.value.trim()),
  );
  const radios = [...form.querySelectorAll('[data-rem], .arrow-pick')].find((row) => !row.querySelector('input[type=radio]:checked'));
  (bad ?? (radios?.querySelector('input[type=radio]') as HTMLElement | undefined))?.focus();
}

function showError(form: HTMLFormElement, msg: string) {
  const el = form.querySelector('[data-error]');
  if (el) el.textContent = msg;
}

function waitForToken(get: () => string | null, failed: () => boolean, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const t = get();
      if (t) return resolve(t);
      if (failed()) return reject(new Error("The spam check couldn't confirm you're human. Try again, or use another browser."));
      if (Date.now() - start > timeoutMs) return reject(new Error('The spam check did not finish. Please try again.'));
      setTimeout(tick, 150);
    };
    tick();
  });
}
