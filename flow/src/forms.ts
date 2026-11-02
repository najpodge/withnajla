import type { Backend } from './backend';
import { LENSES, LENS_LABEL, LIMITS, SHORT_NAME } from './content';
import type { Store } from './store';
import type { Lens, RemediationInput, SectionId, Submission, SubmitResult } from './types';
import { esc } from './util';
import { normalize, validateSubmission } from './validate';

export type FormContext =
  | { kind: 'signal'; stuckPointId: string }
  | { kind: 'remediation'; rootCauseId: string; lens?: Lens }
  | { kind: 'root_cause'; stuckPointId: string }
  | { kind: 'stuck_point'; section?: SectionId | null; name?: string };

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
  name: 'e.g. Review backs up',
  symptom: 'e.g. Review queues grow and approvals turn into “LGTM”',
  rootCause: 'e.g. More output arriving than reviewers can judge',
  signal: 'e.g. Review wait time',
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
  opts: { value?: string; multiline?: boolean; hint?: string; placeholder?: string } = {},
) {
  const id = nextId(name);
  const value = esc(opts.value ?? '');
  const ph = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
  const input = opts.multiline
    ? `<textarea id="${id}" name="${name}" rows="2" maxlength="${max + 20}" data-max="${max}" aria-describedby="${id}-c"${ph} required>${value}</textarea>`
    : `<input id="${id}" name="${name}" type="text" maxlength="${max + 20}" data-max="${max}" value="${value}" aria-describedby="${id}-c"${ph} autocomplete="off" required>`;
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

function signalRow(value = '') {
  const id = nextId('sig');
  return `<div class="signal-row" data-signal>
    <label class="sr-only" for="${id}">Signal</label>
    <input id="${id}" type="text" maxlength="${LIMITS.signal + 20}" data-max="${LIMITS.signal}" value="${esc(value)}" placeholder="${esc(SAMPLE.signal)}" autocomplete="off">
    <button type="button" class="link remove" data-remove-signal aria-label="Remove signal">Remove</button>
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
    if (ctx.kind === 'signal') {
      const sp = store.stuckPoints.get(ctx.stuckPointId)!;
      return {
        title: 'Add a signal',
        ctx: `<p class="ctx-title">${esc(sp.code)} · ${esc(sp.name)}</p><p class="muted">${esc(sp.symptom)}</p>`,
      };
    }
    if (ctx.kind === 'remediation') {
      const rc = store.rootCauses.get(ctx.rootCauseId)!;
      const sp = store.stuckPoints.get(rc.stuck_point_id)!;
      return {
        title: 'Add a remediation',
        ctx: `<p class="ctx-title">${esc(sp.code)} · ${esc(sp.name)}</p><p><span class="muted">Root cause:</span> ${esc(rc.text)}</p>`,
      };
    }
    if (ctx.kind === 'root_cause') {
      const sp = store.stuckPoints.get(ctx.stuckPointId)!;
      return {
        title: 'Add a root cause',
        ctx: `<p class="ctx-title">${esc(sp.code)} · ${esc(sp.name)}</p><p class="muted">${esc(sp.symptom)}</p>`,
      };
    }
    return { title: 'Add a new stuck point', ctx: '' };
  }

  function open(ctx: FormContext, from?: HTMLElement | null) {
    opener = from ?? (document.activeElement as HTMLElement);
    const { title, ctx: ctxHtml } = contextHtml(ctx);

    let fields = '';
    if (ctx.kind === 'stuck_point') {
      const secId = nextId('section');
      fields += `<div class="field">
        <label for="${secId}">Section</label>
        <select id="${secId}" name="section" required>
          <option value="">Choose A–G</option>
          ${store.sections.map((s) => `<option value="${s.id}" ${ctx.section === s.id ? 'selected' : ''}>${s.id} · ${esc(SHORT_NAME[s.id] ?? s.name)}</option>`).join('')}
        </select>
      </div>`;
      fields += textField('name', 'Where flow gets stuck', LIMITS.name, { value: ctx.name, hint: 'A short name', placeholder: SAMPLE.name });
      fields += textField('symptom', 'Symptom', LIMITS.symptom, { multiline: true, hint: 'What you see when it happens', placeholder: SAMPLE.symptom });
      fields += `<div class="field"><p class="label">Signals that show it <span class="muted">(optional, up to ${LIMITS.signals})</span></p>
        <div data-signals>${signalRow()}</div>
        <button type="button" class="link" data-add-signal>+ Add a signal</button></div>`;
    }
    if (ctx.kind === 'signal') {
      fields += `<div class="field"><p class="label">Signals that show it <span class="muted">(up to ${LIMITS.signals})</span></p>
        <p class="hint">A metric or sign you'd watch to see this happening</p>
        <div data-signals>${signalRow()}</div>
        <button type="button" class="link" data-add-signal>+ Add another signal</button></div>`;
    }
    if (ctx.kind === 'root_cause' || ctx.kind === 'stuck_point') {
      fields += textField('root_cause', 'Root cause', LIMITS.text, { multiline: true, hint: 'Why it gets stuck', placeholder: SAMPLE.rootCause });
    }
    const withRems = ctx.kind !== 'signal';

    dialog.innerHTML = `
      <form class="sheet" novalidate>
        <header class="sheet-head">
          <h2 id="sheet-title">${title}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </header>
        <div class="sheet-body">
          ${ctxHtml ? `<div class="ctx">${ctxHtml}</div>` : ''}
          ${fields}
          ${withRems ? `<div data-rems>${remRow(1, ctx.kind === 'remediation' ? ctx.lens : undefined)}</div>
          <button type="button" class="link" data-add-rem>+ Add another remediation</button>` : ''}
          <p class="notice">${NOTICE}</p>
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
      ctx.kind === 'remediation' ? (ctx.lens ? 'textarea' : 'input[type=radio]') : 'select, input[type=text], textarea',
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

  function wire(form: HTMLFormElement, ctx: FormContext) {
    const rems = form.querySelector<HTMLElement>('[data-rems]');
    const renumber = () => {
      if (!rems) return;
      const rows = rems.querySelectorAll('[data-rem]');
      rows.forEach((row, i) => {
        row.querySelector('[data-n]')!.textContent = String(i + 1);
        (row.querySelector('[data-remove]') as HTMLElement).hidden = rows.length === 1;
      });
      (form.querySelector('[data-add-rem]') as HTMLElement).hidden = rows.length >= LIMITS.remediations;
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
      if (t.hasAttribute('data-add-signal')) {
        const box = form.querySelector('[data-signals]')!;
        if (box.children.length < LIMITS.signals) {
          box.insertAdjacentHTML('beforeend', signalRow());
          (box.lastElementChild!.querySelector('input') as HTMLElement).focus();
        }
        t.hidden = box.children.length >= LIMITS.signals;
      }
      if (t.hasAttribute('data-remove-signal')) {
        const box = form.querySelector('[data-signals]')!;
        if (box.children.length > 1) t.closest('[data-signal]')!.remove();
        else (t.closest('[data-signal]')!.querySelector('input') as HTMLInputElement).value = '';
        (form.querySelector('[data-add-signal]') as HTMLElement).hidden = false;
      }
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
  const signals = [...form.querySelectorAll<HTMLInputElement>('[data-signal] input')].map((i) => i.value);
  if (ctx.kind === 'signal') return { type: 'signal', stuck_point_id: ctx.stuckPointId, signals };
  if (ctx.kind === 'remediation') return { type: 'remediation', root_cause_id: ctx.rootCauseId, remediations };
  if (ctx.kind === 'root_cause') {
    return { type: 'root_cause', stuck_point_id: ctx.stuckPointId, root_cause: val('root_cause'), remediations };
  }
  return {
    type: 'stuck_point',
    section: val('section') as SectionId,
    name: val('name'),
    symptom: val('symptom'),
    signals,
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
  const radios = [...form.querySelectorAll('[data-rem]')].find((row) => !row.querySelector('input[type=radio]:checked'));
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
