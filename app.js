/*
 * app.js
 * UI for the workout tracker. All data goes through `Store` (storage.js);
 * PR rules live in `PRs` (prs.js).
 *
 * Structure
 *   - state + refresh()          cached settings, exercises and split
 *   - Units                      kg/lb display and input
 *   - router + render()          hash routes: #log, #calendar, #prs, #settings[/...]
 *   - actions                    click/change/input handlers, found by data-action etc.
 *   - sheets                     bottom sheets: confirm, forms, exercise picker
 *   - screens                    one render() per screen
 */
(function () {
  'use strict';

  const APP_VERSION = '0.3';
  const LB_PER_KG = 2.20462262185;
  const WEEKDAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
  const GROUP_NAMES = { chest: 'Chest', back: 'Back', shoulders: 'Shoulders', legs: 'Legs', arms: 'Arms', core: 'Core', other: 'Other' };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const fmtDuration = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  const ICON = {
    chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>',
    back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>',
    up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3.5 10L8 5.5l4.5 4.5"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3.5 6L8 10.5 12.5 6"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    settings: null,
    exercises: [],          // includes hidden ones
    sessionTypes: [],
    route: { tab: 'log', parts: [] },
    splitDraft: null,       // the session type being edited
    devTaps: [],
    devUnlocked: false,
  };

  async function refresh() {
    const [settings, exercises, sessionTypes] = await Promise.all([
      Store.getSettings(),
      Store.listExercises({ includeArchived: true }),
      Store.listSessionTypes(),
    ]);
    Object.assign(state, { settings, exercises, sessionTypes });
  }

  const exerciseById = (id) => state.exercises.find((e) => e.id === id);
  const exerciseName = (id) => (exerciseById(id) || { name: 'Unknown exercise' }).name;

  /* ------------------------------------------------------------------ */
  /* Units: stored in kg, shown and typed in the chosen unit              */
  /* ------------------------------------------------------------------ */

  const Units = {
    get unit() { return state.settings.units; },
    /** Number in display units, rounded for display (kg 2 dp, lb 1 dp). null stays null. */
    display(kg) {
      if (kg == null) return null;
      if (this.unit === 'lb') return Math.round(kg * LB_PER_KG * 10) / 10;
      return Math.round(kg * 100) / 100;
    },
    /** "80", "−20", "BW". */
    format(kg, { bw = 'BW' } = {}) {
      const v = this.display(kg);
      if (v == null) return bw;
      return v < 0 ? `−${Math.abs(v)}` : String(v);
    },
    /** Parses typed text. '' → null (bodyweight). Returns { kg } or { error }. */
    parse(text) {
      const t = String(text == null ? '' : text).trim().replace(',', '.').replace('−', '-');
      if (t === '') return { kg: null };
      if (!/^[-+]?\d*\.?\d+$/.test(t)) return { error: 'Weight must be a number. Leave it blank for bodyweight.' };
      const v = Number(t);
      return { kg: this.unit === 'lb' ? v / LB_PER_KG : v };
    },
  };

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    const pref = state.settings ? state.settings.theme : 'system';
    const root = document.documentElement;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
    const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#0E1411' : '#F3F5F3');
  }
  darkQuery.addEventListener('change', applyTheme);

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message, { error = false } = {}) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.toggle('error', error);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), error ? 4200 : 2200);
  }

  /* ------------------------------------------------------------------ */
  /* Router and rendering                                                */
  /* ------------------------------------------------------------------ */

  const TABS = ['log', 'calendar', 'prs', 'settings'];

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const tab = TABS.includes(parts[0]) ? parts[0] : 'log';
    return { tab, parts: TABS.includes(parts[0]) ? parts.slice(1) : [] };
  }

  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

  let renderToken = 0;
  async function render({ keepScroll = false } = {}) {
    const token = ++renderToken;
    const y = window.scrollY;
    const screen = screens[state.route.tab];
    let html;
    try {
      html = await screen.render(state.route.parts);
    } catch (err) {
      console.error(err);
      html = `<div class="fatal"><h1>Something went wrong</h1><p>${esc(err.message)}</p></div>`;
    }
    if (token !== renderToken) return;          // a newer render started
    $('#view').innerHTML = html;
    if (screen.after) screen.after($('#view'));
    $$('.tabbar a').forEach((a) => {
      if (a.dataset.tab === state.route.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, keepScroll ? y : 0);
  }

  window.addEventListener('hashchange', () => {
    const prev = state.route;
    state.route = parseRoute();
    if (prev.tab === 'settings' && prev.parts[0] === 'split' && state.route.parts[0] !== 'split') state.splitDraft = null;
    closeSheet();
    render();
  });

  /* ------------------------------------------------------------------ */
  /* Actions (event delegation)                                          */
  /* ------------------------------------------------------------------ */

  const actions = {};      // click:  data-action="name"
  const changes = {};      // change: data-change="name"
  const inputs = {};       // input:  data-input="name"

  async function runHandler(fn, el, ev) {
    try {
      await fn(el, ev);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Something went wrong.', { error: true });
    }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    ev.preventDefault();
    runHandler(fn, el, ev);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) runHandler(changes[el.dataset.change], el, ev);
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-input]');
    if (el && inputs[el.dataset.input]) runHandler(inputs[el.dataset.input], el, ev);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && sheet) closeSheet(null);
  });

  /* ------------------------------------------------------------------ */
  /* Bottom sheets                                                       */
  /* ------------------------------------------------------------------ */

  let sheet = null;   // { resolve, onSubmit, returnFocus }

  function openSheet(html, { resolve = () => {}, onSubmit = null, label = 'Dialog' } = {}) {
    if (sheet) closeSheet(null);
    const root = $('#sheet-root');
    root.innerHTML = `<div class="backdrop" data-action="sheet-cancel"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
    root.hidden = false;
    document.body.classList.add('sheet-open');
    sheet = { resolve, onSubmit, returnFocus: document.activeElement };
    const first = $('[autofocus]', root) || $('.sheet button, .sheet input, .sheet select', root);
    if (first) first.focus({ preventScroll: true });
  }

  /** Closes the open sheet. `result` goes to whoever opened it unless `silent`. */
  function closeSheet(result = null, { silent = false } = {}) {
    if (!sheet) return null;
    const { resolve, returnFocus } = sheet;
    sheet = null;
    const root = $('#sheet-root');
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    if (!silent) resolve(result);
    return resolve;
  }

  actions['sheet-cancel'] = () => closeSheet(null);
  actions['sheet-ok'] = () => closeSheet(true);

  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-form="sheet"]');
    if (!form || !sheet) return;
    ev.preventDefault();
    const values = {};
    for (const el of form.elements) if (el.name) values[el.name] = el.value;
    const errorEl = $('.form-error', form);
    try {
      const result = sheet.onSubmit ? await sheet.onSubmit(values) : values;
      closeSheet(result);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  /** Yes/no sheet. Resolves true or null. */
  function confirmSheet({ title, body = '', confirmLabel = 'OK', danger = false }) {
    return new Promise((resolve) => {
      openSheet(`
        <h2 class="sheet-title">${esc(title)}</h2>
        ${body ? `<p class="sheet-body">${esc(body)}</p>` : ''}
        <div class="sheet-actions">
          <button class="btn btn-secondary" data-action="sheet-cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="sheet-ok">${esc(confirmLabel)}</button>
        </div>`, { resolve, label: title });
    });
  }

  /**
   * Form sheet. fields: [{ name, label, type: 'text'|'select', value, options: [[value, label]], placeholder }]
   * onSubmit(values) may throw to show an error and keep the sheet open.
   */
  function formSheet({ title, fields, submitLabel = 'Save', onSubmit }) {
    const fieldHtml = (f, i) => {
      const id = `sheet-${f.name}`;
      if (f.type === 'select') {
        return `<div class="field"><label for="${id}">${esc(f.label)}</label>
          <span class="select-wrap"><select class="select" id="${id}" name="${esc(f.name)}">
          ${f.options.map(([v, l]) => `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select></span></div>`;
      }
      return `<div class="field"><label for="${id}">${esc(f.label)}</label>
        <input class="input" id="${id}" name="${esc(f.name)}" type="text" value="${esc(f.value || '')}"
          placeholder="${esc(f.placeholder || '')}" autocomplete="off" ${i === 0 ? 'autofocus' : ''}></div>`;
    };
    return new Promise((resolve) => {
      openSheet(`
        <form class="sheet-form" data-form="sheet" novalidate>
          <h2 class="sheet-title">${esc(title)}</h2>
          ${fields.map(fieldHtml).join('')}
          <p class="form-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn btn-secondary" data-action="sheet-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
          </div>
        </form>`, { resolve, onSubmit, label: title });
    });
  }

  const groupOptions = () => Store.MUSCLE_GROUPS.map((g) => [g, GROUP_NAMES[g]]);

  /** Add-exercise sheet. Resolves the new exercise or null. */
  async function addExerciseSheet(name = '') {
    const ex = await formSheet({
      title: 'New exercise',
      submitLabel: 'Add exercise',
      fields: [
        { name: 'name', label: 'Name', value: name, placeholder: 'e.g. Landmine Press' },
        { name: 'group', label: 'Muscle group', type: 'select', value: 'other', options: groupOptions() },
      ],
      onSubmit: (v) => Store.addExercise({ name: v.name, group: v.group }),
    });
    if (ex) { await refresh(); toast(`Added ${ex.name}`); }
    return ex;
  }

  /**
   * Exercise picker. Resolves an exercise id or null.
   * exclude: ids to leave out (e.g. already in the split).
   */
  function pickExercise({ title = 'Add exercise', exclude = [] } = {}) {
    const visible = state.exercises.filter((e) => !e.archived && !exclude.includes(e.id));
    const groups = Store.MUSCLE_GROUPS
      .map((g) => [g, visible.filter((e) => e.group === g).sort((a, b) => a.name.localeCompare(b.name))])
      .filter(([, list]) => list.length);
    return new Promise((resolve) => {
      openSheet(`
        <h2 class="sheet-title">${esc(title)}</h2>
        <div class="picker-search">
          <label class="visually-hidden" for="picker-q">Search exercises</label>
          <input class="input" id="picker-q" type="search" placeholder="Search or type a new name" autocomplete="off" data-input="picker-search" autofocus>
        </div>
        <button class="picker-create" data-action="picker-create" hidden></button>
        <div class="picker-list">
          ${groups.map(([g, list]) => `
            <section data-group>
              <h3 class="picker-group-title">${GROUP_NAMES[g]}</h3>
              ${list.map((e) => `<button class="picker-item" data-action="picker-pick" data-id="${esc(e.id)}" data-name="${esc(e.name.toLowerCase())}">${esc(e.name)}</button>`).join('')}
            </section>`).join('')}
        </div>
        <p class="empty" data-picker-empty hidden>No match. Use the button above to create it.</p>`,
      { resolve, label: title });
    });
  }

  inputs['picker-search'] = (el) => {
    const q = el.value.trim().toLowerCase();
    let any = false;
    $$('#sheet-root [data-group]').forEach((sec) => {
      let shown = 0;
      $$('.picker-item', sec).forEach((item) => {
        const hit = !q || item.dataset.name.includes(q);
        item.hidden = !hit;
        if (hit) shown++;
      });
      sec.hidden = !shown;
      any = any || shown > 0;
    });
    const exact = state.exercises.some((e) => !e.archived && e.name.toLowerCase() === q);
    const create = $('#sheet-root [data-action="picker-create"]');
    create.hidden = !q || exact;
    create.textContent = `+ Create “${el.value.trim()}”`;
    $('#sheet-root [data-picker-empty]').hidden = any || !q;
  };
  actions['picker-pick'] = (el) => closeSheet(el.dataset.id);
  actions['picker-create'] = async () => {
    const name = $('#picker-q').value.trim();
    const resolvePicker = closeSheet(null, { silent: true });
    const ex = await addExerciseSheet(name);
    resolvePicker(ex ? ex.id : null);
  };

  /* ------------------------------------------------------------------ */
  /* Shared markup                                                       */
  /* ------------------------------------------------------------------ */

  const head = (title, { back } = {}) => `
    <header class="screen-head">
      ${back ? `<a class="back" href="${back.href}">${ICON.back}<span>${esc(back.label)}</span></a>` : ''}
      <h1>${esc(title)}</h1>
    </header>`;

  const seg = (action, value, options) => `
    <div class="seg" role="group">
      ${options.map(([v, l]) => `<button data-action="${action}" data-value="${esc(v)}" aria-pressed="${v === value}">${esc(l)}</button>`).join('')}
    </div>`;

  const sw = (action, on, label) =>
    `<button class="switch" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-action="${action}"></button>`;

  /* ------------------------------------------------------------------ */
  /* Screens                                                             */
  /* ------------------------------------------------------------------ */

  const screens = {};

  /* ---------- Log, Calendar, PRs: placeholders until their stages ---------- */

  screens.log = {
    async render() {
      return `${head('Log')}
        <div class="placeholder"><strong>The workout screen comes in stage 4.</strong>
        <span>Set up your split, units and timer in Settings meanwhile.</span></div>`;
    },
  };
  screens.calendar = {
    async render() {
      return `${head('Calendar')}<div class="placeholder"><strong>The calendar comes in stage 5.</strong></div>`;
    },
  };
  screens.prs = {
    async render() {
      return `${head('PRs')}<div class="placeholder"><strong>Milestones and charts come in stage 6.</strong></div>`;
    },
  };

  /* ---------- Settings ---------- */

  screens.settings = {
    async render(parts) {
      if (parts[0] === 'split') return renderSplitEditor(parts[1]);
      if (parts[0] === 'exercises') return renderLibrary();
      return renderSettings();
    },
  };

  function renderSettings() {
    const s = state.settings;
    const rt = s.restTimer;
    const types = state.sessionTypes;
    const typeOptions = [['', 'Rest day'], ...types.map((t) => [t.id, t.name])];
    const setsIn = (t) => t.items.reduce((n, i) => n + i.targetSets, 0);
    const customCount = state.exercises.filter((e) => e.custom && !e.archived).length;
    const hiddenCount = state.exercises.filter((e) => e.archived).length;

    return `${head('Settings')}

    <section class="group">
      <h2 class="group-title">Display</h2>
      <div class="list">
        <div class="row"><span class="row-label">Weight unit</span>
          ${seg('set-units', s.units, [['kg', 'kg'], ['lb', 'lb']])}</div>
        <div class="row"><span class="row-label">Theme</span>
          ${seg('set-theme', s.theme, [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      </div>
    </section>

    <section class="group">
      <h2 class="group-title">Workout screen</h2>
      <div class="list">
        <div class="row"><span class="row-label">RPE slider<small>Rate each set from 6 to 10</small></span>
          ${sw('toggle-rpe', s.rpeEnabled, 'RPE slider')}</div>
        <div class="row"><span class="row-label">Rest timer</span>
          ${sw('toggle-rest', rt.enabled, 'Rest timer')}</div>
        ${rt.enabled ? `
        <div class="row sub"><span class="row-label">Start</span>
          ${seg('set-rest-start', rt.autoStart ? 'auto' : 'manual', [['manual', 'Manual'], ['auto', 'After each set']])}</div>
        <div class="row sub"><span class="row-label">Rest time</span>
          <div class="stepper-sm">
            <button data-action="rest-step" data-step="-15" aria-label="15 seconds less">−</button>
            <output class="num">${fmtDuration(rt.durationSec)}</output>
            <button data-action="rest-step" data-step="15" aria-label="15 seconds more">+</button>
          </div></div>` : ''}
      </div>
    </section>

    <section class="group">
      <h2 class="group-title">Split</h2>
      <div class="list">
        ${types.length ? types.map((t) => `
          <a class="row" href="#settings/split/${encodeURIComponent(t.id)}">
            <span class="row-label">${esc(t.name)}<small>${plural(t.items.length, 'exercise')} · ${plural(setsIn(t), 'set')}</small></span>
            ${ICON.chev}
          </a>`).join('') : `
          <p class="empty">No split yet. Add session types like Push, Pull or Legs to get a “Next exercise” suggestion while you train. You can always train freestyle without one.</p>`}
      </div>
      <div class="actions-bar"><a class="btn btn-secondary btn-block" href="#settings/split/new">+ New session type</a></div>
    </section>

    <section class="group">
      <h2 class="group-title">Weekly schedule</h2>
      <div class="list">
        <div class="row"><span class="row-label">Use a weekly schedule<small>Today’s session is ready to start on the Log tab</small></span>
          ${sw('toggle-schedule', s.schedule.enabled, 'Weekly schedule')}</div>
        ${s.schedule.enabled ? (types.length ? WEEKDAYS.map(([d, name]) => `
          <div class="row sub"><label class="row-label" for="day-${d}">${name}</label>
            <span class="select-wrap"><select class="select" id="day-${d}" data-change="set-day" data-day="${d}">
              ${typeOptions.map(([v, l]) => `<option value="${esc(v)}"${(s.schedule.days[d] || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
            </select></span></div>`).join('')
          : '<p class="empty">Create a session type in your split first, then pick one for each day.</p>') : ''}
      </div>
    </section>

    <section class="group">
      <h2 class="group-title">Exercises</h2>
      <div class="list">
        <a class="row" href="#settings/exercises">
          <span class="row-label">Exercise library<small>${plural(customCount, 'custom exercise')}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}</small></span>
          ${ICON.chev}
        </a>
      </div>
    </section>

    <section class="group">
      <h2 class="group-title">Your data</h2>
      <div class="list">
        <button class="row" data-action="export">
          <span class="row-label">Export data<small>Save everything as a JSON file</small></span>${ICON.chev}</button>
        <button class="row" data-action="import">
          <span class="row-label">Import data<small>Replace everything here with a file you exported</small></span>${ICON.chev}</button>
      </div>
      <p class="group-note">Your data is stored in this browser on this device only. Export a copy now and then.</p>
      <input type="file" id="import-file" accept="application/json,.json" data-change="import-file" hidden>
    </section>

    ${state.devUnlocked ? `
    <section class="group">
      <h2 class="group-title">Developer</h2>
      <div class="list">
        <button class="row" data-action="load-sample">
          <span class="row-label">Load sample data<small>Nine weeks of Push / Pull / Legs. Replaces your workout history.</small></span>${ICON.chev}</button>
        <a class="row" href="tests.html"><span class="row-label">Run tests</span>${ICON.chev}</a>
        <button class="row" data-action="reset-all">
          <span class="row-label" style="color:var(--danger)">Erase all data</span></button>
      </div>
    </section>` : ''}

    <section class="group">
      <div class="list">
        <button class="row" data-action="version-tap">
          <span class="row-label">Workout Tracker<small>Version ${APP_VERSION}</small></span></button>
      </div>
    </section>`;
  }

  async function saveSettings(patch, message) {
    state.settings = await Store.updateSettings(patch);
    applyTheme();
    await render({ keepScroll: true });
    if (message) toast(message);
  }

  actions['set-units'] = (el) => saveSettings({ units: el.dataset.value });
  actions['set-theme'] = (el) => saveSettings({ theme: el.dataset.value });
  actions['toggle-rpe'] = () => saveSettings({ rpeEnabled: !state.settings.rpeEnabled });
  actions['toggle-rest'] = () => saveSettings({ restTimer: { enabled: !state.settings.restTimer.enabled } });
  actions['set-rest-start'] = (el) => saveSettings({ restTimer: { autoStart: el.dataset.value === 'auto' } });
  actions['rest-step'] = (el) => {
    const next = Math.min(600, Math.max(15, state.settings.restTimer.durationSec + Number(el.dataset.step)));
    return saveSettings({ restTimer: { durationSec: next } });
  };
  actions['toggle-schedule'] = () => saveSettings({ schedule: { enabled: !state.settings.schedule.enabled } });
  changes['set-day'] = (el) => saveSettings({ schedule: { days: { [el.dataset.day]: el.value || null } } });

  actions['version-tap'] = () => {
    const now = Date.now();
    state.devTaps = state.devTaps.filter((t) => now - t < 3000).concat(now);
    if (state.devTaps.length >= 5 && !state.devUnlocked) {
      state.devUnlocked = true;
      state.devTaps = [];
      toast('Developer options are on');
      render({ keepScroll: true });
    }
  };

  /* ---------- Export / import / sample / reset ---------- */

  actions.export = async () => {
    const data = await Store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workout-tracker-${Store.util.dateKey()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Exported ${plural(data.sessions.length, 'session')}`);
  };

  actions.import = () => $('#import-file').click();

  changes['import-file'] = async (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      throw new Error('That file is not a workout export (it is not valid JSON).');
    }
    const n = Array.isArray(data.sessions) ? data.sessions.length : 0;
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'an unknown date';
    const ok = await confirmSheet({
      title: 'Replace all data?',
      body: `“${file.name}” from ${when} has ${plural(n, 'session')}. Importing replaces everything in the app, including settings. Export first if you want to keep what is here.`,
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!ok) return;
    const res = await Store.importData(data);
    await refresh();
    applyTheme();
    await render();
    toast(`Imported ${plural(res.sessions, 'session')}`);
  };

  actions['load-sample'] = async () => {
    const ok = await confirmSheet({
      title: 'Load sample data?',
      body: 'This replaces your sessions, split, milestones and weigh-ins with nine weeks of sample training. Your settings and exercises stay. Export first if you want to keep your history.',
      confirmLabel: 'Load sample data',
      danger: true,
    });
    if (!ok) return;
    const base = await Store.exportData();
    const res = await Store.importData(SampleData.build({ base }));
    await refresh();
    await render({ keepScroll: true });
    toast(`Loaded ${plural(res.sessions, 'sample session')}`);
  };

  actions['reset-all'] = async () => {
    const ok = await confirmSheet({
      title: 'Erase all data?',
      body: 'Every session, milestone, weigh-in, custom exercise and setting will be deleted. This cannot be undone.',
      confirmLabel: 'Erase everything',
      danger: true,
    });
    if (!ok) return;
    await Store.resetAll();
    await refresh();
    applyTheme();
    await render();
    toast('All data erased');
  };

  /* ---------- Split editor ---------- */

  function renderSplitEditor(id) {
    const isNew = !id || id === 'new';
    if (!state.splitDraft || state.splitDraft.routeId !== (id || 'new')) {
      const existing = isNew ? null : state.sessionTypes.find((t) => t.id === id);
      if (!isNew && !existing) {
        return `${head('Not found', { back: { href: '#settings', label: 'Settings' } })}
          <p class="empty">This session type was deleted.</p>`;
      }
      state.splitDraft = existing
        ? { routeId: id, id: existing.id, name: existing.name, items: existing.items.map((i) => ({ ...i })) }
        : { routeId: 'new', id: null, name: '', items: [] };
    }
    const d = state.splitDraft;
    const n = d.items.length;
    return `${head(isNew ? 'New session type' : d.name || 'Session type', { back: { href: '#settings', label: 'Settings' } })}
      <div class="page-pad">
        <div class="field">
          <label for="split-name">Name</label>
          <input class="input" id="split-name" type="text" value="${esc(d.name)}" placeholder="e.g. Push, Legs, Upper" autocomplete="off" data-input="split-name" ${isNew ? 'autofocus' : ''}>
        </div>
      </div>
      <section class="group" style="margin-top:4px">
        <h2 class="group-title">Exercises, in order</h2>
        ${n ? `<ol class="edit-list">
          ${d.items.map((it, i) => `
            <li class="edit-row">
              <span class="idx num">${i + 1}</span>
              <span class="name">${esc(exerciseName(it.exerciseId))}</span>
              <button class="icon-btn remove" data-action="split-remove" data-i="${i}" aria-label="Remove ${esc(exerciseName(it.exerciseId))}">${ICON.x}</button>
              <div class="controls">
                <div class="stepper-sm" aria-label="Target sets">
                  <button data-action="split-sets" data-i="${i}" data-step="-1" aria-label="One fewer set">−</button>
                  <output class="num">${plural(it.targetSets, 'set')}</output>
                  <button data-action="split-sets" data-i="${i}" data-step="1" aria-label="One more set">+</button>
                </div>
                <span class="grow"></span>
                <button class="icon-btn" data-action="split-move" data-i="${i}" data-step="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
                <button class="icon-btn" data-action="split-move" data-i="${i}" data-step="1" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
              </div>
            </li>`).join('')}
        </ol>` : '<div class="list"><p class="empty">No exercises yet. Add them in the order you usually do them.</p></div>'}
        <div class="actions-bar">
          <button class="btn btn-secondary btn-block" data-action="split-add">+ Add exercise</button>
        </div>
      </section>
      <div class="actions-bar">
        <p class="form-error" id="split-error" hidden></p>
        <button class="btn btn-primary btn-block" data-action="split-save">Save</button>
        ${isNew ? '' : '<button class="btn btn-danger btn-block" data-action="split-delete">Delete session type</button>'}
      </div>`;
  }

  inputs['split-name'] = (el) => { if (state.splitDraft) state.splitDraft.name = el.value; };

  actions['split-add'] = async () => {
    const d = state.splitDraft;
    const id = await pickExercise({ exclude: d.items.map((i) => i.exerciseId) });
    if (!id || state.splitDraft !== d) return;
    d.items.push({ exerciseId: id, targetSets: 3 });
    await render({ keepScroll: true });
  };
  actions['split-remove'] = (el) => {
    state.splitDraft.items.splice(Number(el.dataset.i), 1);
    return render({ keepScroll: true });
  };
  actions['split-sets'] = (el) => {
    const it = state.splitDraft.items[Number(el.dataset.i)];
    it.targetSets = Math.min(20, Math.max(1, it.targetSets + Number(el.dataset.step)));
    return render({ keepScroll: true });
  };
  actions['split-move'] = (el) => {
    const items = state.splitDraft.items;
    const i = Number(el.dataset.i);
    const j = i + Number(el.dataset.step);
    if (j < 0 || j >= items.length) return null;
    [items[i], items[j]] = [items[j], items[i]];
    return render({ keepScroll: true });
  };
  actions['split-save'] = async () => {
    const d = state.splitDraft;
    try {
      const saved = await Store.saveSessionType({ id: d.id, name: d.name, items: d.items });
      state.splitDraft = null;
      await refresh();
      go('#settings');
      toast(`Saved ${saved.name}`);
    } catch (err) {
      const e = $('#split-error');
      e.textContent = err.message;
      e.hidden = false;
    }
  };
  actions['split-delete'] = async () => {
    const d = state.splitDraft;
    const ok = await confirmSheet({
      title: `Delete ${d.name}?`,
      body: 'Past sessions keep all their sets and show as Freestyle. Any weekday set to this session becomes a rest day.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await Store.deleteSessionType(d.id);
    state.splitDraft = null;
    await refresh();
    go('#settings');
    toast(`Deleted ${d.name}`);
  };

  /* ---------- Exercise library ---------- */

  function renderLibrary() {
    const shown = state.exercises.filter((e) => !e.archived);
    const hidden = state.exercises.filter((e) => e.archived).sort((a, b) => a.name.localeCompare(b.name));
    const row = (e) => `
      <div class="lib-row">
        <span class="name">${esc(e.name)}${e.custom ? '<span class="tag">Custom</span>' : ''}</span>
        <button class="text-btn" data-action="ex-edit" data-id="${esc(e.id)}">Edit</button>
        <button class="text-btn" data-action="ex-hide" data-id="${esc(e.id)}">${e.archived ? 'Show' : 'Hide'}</button>
      </div>`;
    return `${head('Exercise library', { back: { href: '#settings', label: 'Settings' } })}
      <div class="actions-bar"><button class="btn btn-primary btn-block" data-action="ex-add">+ New exercise</button></div>
      ${Store.MUSCLE_GROUPS.map((g) => {
        const list = shown.filter((e) => e.group === g).sort((a, b) => a.name.localeCompare(b.name));
        return list.length ? `<section class="group" style="margin-top:12px">
          <h2 class="group-title">${GROUP_NAMES[g]}</h2><div class="list">${list.map(row).join('')}</div></section>` : '';
      }).join('')}
      ${hidden.length ? `<section class="group">
        <h2 class="group-title">Hidden</h2><div class="list">${hidden.map(row).join('')}</div>
        <p class="group-note">Hidden exercises don’t appear when you pick one. Their history and milestones are kept.</p>
      </section>` : ''}
      <div style="height:16px"></div>`;
  }

  actions['ex-add'] = async () => { if (await addExerciseSheet()) await render({ keepScroll: true }); };

  actions['ex-edit'] = async (el) => {
    const e = exerciseById(el.dataset.id);
    const res = await formSheet({
      title: 'Edit exercise',
      fields: [
        { name: 'name', label: 'Name', value: e.name },
        { name: 'group', label: 'Muscle group', type: 'select', value: e.group, options: groupOptions() },
      ],
      onSubmit: (v) => Store.updateExercise(e.id, { name: v.name, group: v.group }),
    });
    if (!res) return;
    await refresh();
    await render({ keepScroll: true });
    toast('Saved. Past sessions show the new name.');
  };

  actions['ex-hide'] = async (el) => {
    const e = exerciseById(el.dataset.id);
    await Store.setExerciseArchived(e.id, !e.archived);
    await refresh();
    await render({ keepScroll: true });
    toast(e.archived ? `${e.name} is back in the list` : `${e.name} is hidden`);
  };

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    try {
      await Store.init();
      await refresh();
    } catch (err) {
      console.error(err);
      $('#view').innerHTML = `<div class="fatal"><h1>Your data couldn’t be opened</h1>
        <p>${esc(err.message)}</p><p class="muted">Nothing was deleted. Reload the page to try again.</p></div>`;
      return;
    }
    applyTheme();
    state.route = parseRoute();
    render();
  }

  // For debugging in the console only.
  window.WT = { state, Units, render, refresh };

  boot();
})();
