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

  const APP_VERSION = '0.13';   // keep in step with VERSION in sw.js
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

  /** Colour options shown in Settings: [id, name, light swatch, dark swatch, tick colour light, tick colour dark]. */
  const ACCENT_OPTIONS = [
    ['green', 'Green', '#127A43', '#3CC27A', '#FFFFFF', '#04140B'],
    ['blue', 'Blue', '#1F4FD8', '#6E9BFF', '#FFFFFF', '#08122A'],
    ['red', 'Red', '#C8102E', '#FF4D5E', '#FFFFFF', '#1A0508'],
    ['orange', 'Orange', '#C93F0A', '#FF6A2B', '#FFFFFF', '#1A0A02'],
    ['yellow', 'Yellow', '#F2C200', '#F5C518', '#141412', '#141412'],
    ['graphite', 'Graphite', '#1A1A1A', '#F0F0F0', '#FFFFFF', '#121212'],
  ];

  function applyTheme() {
    const pref = state.settings ? state.settings.theme : 'system';
    const accent = state.settings ? state.settings.accent : 'green';
    const root = document.documentElement;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
    if (!accent || accent === 'green') delete root.dataset.accent;
    else root.dataset.accent = accent;
    // The phone's status bar matches the page background of the current palette.
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    $('meta[name="theme-color"]').setAttribute('content', bg || '#F3F5F3');
  }
  const isDark = (pref) => pref === 'dark' || (pref === 'system' && darkQuery.matches);

  /**
   * Runs `update` (which changes the theme) with a transition: the new theme
   * spreads out in a circle from `origin` (the tapped button, or the screen
   * centre). Browsers without View Transitions get a colour cross-fade instead.
   */
  async function withThemeTransition(update, origin) {
    const root = document.documentElement;
    if (reduceMotion.matches) return update();
    if (!document.startViewTransition) {
      root.classList.add('theme-fade');
      await update();
      setTimeout(() => root.classList.remove('theme-fade'), 450);
      return undefined;
    }
    const x = origin ? origin.x : window.innerWidth / 2;
    const y = origin ? origin.y : window.innerHeight / 2;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty('--vt-x', `${x}px`);
    root.style.setProperty('--vt-y', `${y}px`);
    root.style.setProperty('--vt-r', `${Math.ceil(r)}px`);
    const vt = document.startViewTransition(() => update());
    try { await vt.finished; } catch (_) { /* skipped */ }
    return undefined;
  }

  darkQuery.addEventListener('change', () => {
    // Only "Auto" follows the system, so only then is there anything to animate.
    if (state.settings && state.settings.theme === 'system') withThemeTransition(applyTheme);
    else applyTheme();
  });

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  /** action: { label, run } adds a button (e.g. Undo) and keeps the toast up longer. */
  function toast(message, { error = false, action = null } = {}) {
    const t = $('#toast');
    t.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = message;
    t.append(msg);
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        t.classList.remove('show', 'has-action');
        clearTimeout(toastTimer);
        runHandler(action.run);
      }, { once: true });
      t.append(b);
    }
    t.classList.toggle('error', error);
    t.classList.toggle('has-action', !!action);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show', 'has-action'), action ? 6000 : error ? 4200 : 2200);
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
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** Small "bump" on a number that just changed (reps, drop reps). */
  function bump(el) {
    if (!el || reduceMotion.matches || !el.animate) return;
    el.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 170, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }

  const ENTER_CLASSES = ['view-enter', 'enter-next', 'enter-prev', 'swipe-next', 'swipe-prev'];

  /**
   * animate: how the new screen arrives. true = fade (a sub-screen),
   * 'enter-next' / 'enter-prev' = slide in from the right / left (tab tap),
   * 'swipe-next' / 'swipe-prev' = full slide after a swipe. In-place updates pass nothing.
   */
  async function render({ keepScroll = false, animate = false } = {}) {
    const token = ++renderToken;
    const y = $('#view').scrollTop;     // #view is the scrolling area
    const screen = screens[state.route.tab];
    let html;
    try {
      html = await screen.render(state.route.parts);
    } catch (err) {
      console.error(err);
      html = `<div class="fatal"><h1>Something went wrong</h1><p>${esc(err.message)}</p></div>`;
    }
    if (token !== renderToken) return;          // a newer render started
    const view = $('#view');
    view.classList.remove(...ENTER_CLASSES);     // in-place updates never animate
    Object.assign(view.style, { transition: '', transform: '', opacity: '' });   // end of a swipe
    view.innerHTML = html;
    if (animate && !reduceMotion.matches) {
      void view.offsetWidth;                     // restart the animation
      view.classList.add(animate === true ? 'view-enter' : animate);
    }
    if (screen.after) screen.after(view);
    $$('.tabbar a').forEach((a) => {
      if (a.dataset.tab === state.route.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    moveTabIndicator(TABS.indexOf(state.route.tab));
    view.scrollTop = keepScroll ? y : 0;
  }

  window.addEventListener('hashchange', () => {
    const prev = state.route;
    state.route = parseRoute();
    if (prev.tab === 'settings' && prev.parts[0] === 'split' && state.route.parts[0] !== 'split') state.splitDraft = null;
    closeSheet();
    const sameCalendar = prev.tab === 'calendar' && state.route.tab === 'calendar';
    let animate = !sameCalendar;
    if (prev.tab !== state.route.tab) {
      const forward = TABS.indexOf(state.route.tab) > TABS.indexOf(prev.tab);
      animate = state.pendingSwipe ? (forward ? 'swipe-next' : 'swipe-prev') : (forward ? 'enter-next' : 'enter-prev');
    }
    state.pendingSwipe = false;
    render({ keepScroll: sameCalendar, animate });
  });

  /* ------------------------------------------------------------------ */
  /* Tab bar indicator: one green bar that slides between tabs and       */
  /* follows the finger during a swipe.                                  */
  /* ------------------------------------------------------------------ */

  const tabIndicator = document.createElement('span');
  tabIndicator.className = 'tab-ind';
  tabIndicator.setAttribute('aria-hidden', 'true');
  $('.tabbar').append(tabIndicator);

  /** pos: tab index, fractional while dragging. */
  function moveTabIndicator(pos, { instant = false } = {}) {
    tabIndicator.style.transition = instant ? 'none' : '';
    tabIndicator.style.transform = `translateX(${(pos * 100).toFixed(2)}%)`;
  }

  /* ------------------------------------------------------------------ */
  /* Swipe left / right on a screen to move to the next / previous tab.  */
  /* The page follows the finger; a short or slow swipe springs back.    */
  /* Not started on inputs, sliders, the exercise chip row, near the     */
  /* screen edges (Android's back gesture) or while a sheet is open.     */
  /* ------------------------------------------------------------------ */

  (function swipeTabs() {
    const view = $('#view');
    // Listen on the whole app (it fills the screen), not just #view, which is only as tall as its content.
    const area = $('#app');
    const EDGE = 24;
    let s = null;
    let busy = false;
    const blocked = (el) => el.closest('input, textarea, select, [contenteditable], .ex-strip, .drop-edit, .no-swipe');

    function reset(animated) {
      view.style.transition = animated ? 'transform 220ms var(--ease), opacity 220ms var(--ease)' : '';
      view.style.transform = '';
      view.style.opacity = '';
      moveTabIndicator(TABS.indexOf(state.route.tab));
      if (animated) setTimeout(() => { if (!s) view.style.transition = ''; }, 240);
    }

    area.addEventListener('touchstart', (ev) => {
      if (busy || ev.touches.length !== 1 || sheet || !$('#timer-overlay').hidden) return;
      const t = ev.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE || blocked(ev.target)) return;
      s = { x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, lock: null, idx: TABS.indexOf(state.route.tab) };
    }, { passive: true });

    area.addEventListener('touchmove', (ev) => {
      if (!s) return;
      const t = ev.touches[0];
      const dx = t.clientX - s.x0;
      const dy = t.clientY - s.y0;
      if (!s.lock) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        s.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (s.lock === 'y') { s = null; return; }
        view.classList.remove(...ENTER_CLASSES);
        view.style.transition = 'none';
      }
      ev.preventDefault();                      // horizontal: don't let the page scroll
      const outOfTabs = (dx > 0 && s.idx === 0) || (dx < 0 && s.idx === TABS.length - 1);
      s.dx = outOfTabs ? dx * 0.25 : dx;       // rubber band past the first / last tab
      const w = window.innerWidth;
      view.style.transform = `translateX(${s.dx}px)`;
      view.style.opacity = String(1 - Math.min(Math.abs(s.dx) / w, 1) * 0.3);
      moveTabIndicator(Math.max(0, Math.min(TABS.length - 1, s.idx - s.dx / w)), { instant: true });
    }, { passive: false });

    function end() {
      if (!s) return;
      const { dx, idx, t0, lock } = s;
      s = null;
      if (lock !== 'x') return;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);   // px per ms
      const dir = dx < 0 ? 1 : -1;
      const target = idx + dir;
      const commit = target >= 0 && target < TABS.length
        && (Math.abs(dx) > window.innerWidth * 0.28 || (speed > 0.45 && Math.abs(dx) > 40));
      if (!commit) { reset(true); return; }
      busy = true;
      state.pendingSwipe = true;
      const finish = () => { busy = false; location.hash = `#${TABS[target]}`; };
      if (reduceMotion.matches) { finish(); return; }
      view.style.transition = 'transform 170ms var(--ease), opacity 170ms var(--ease)';
      view.style.transform = `translateX(${dir > 0 ? '-100%' : '100%'})`;
      view.style.opacity = '0.4';
      moveTabIndicator(target);
      setTimeout(finish, 170);                 // render() clears these styles when the new tab is in
    }
    area.addEventListener('touchend', end);
    area.addEventListener('touchcancel', () => { if (s) { s = null; reset(true); } });
  })();

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
    // Slide the sheet out, then remove it (unless another sheet has opened meanwhile).
    const leaving = [...root.children];
    leaving.forEach((n) => n.classList.add('closing'));
    const finish = () => {
      leaving.forEach((n) => n.remove());
      if (!sheet) { root.hidden = true; }
    };
    if (reduceMotion.matches) finish(); else setTimeout(finish, 160);
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
        <input class="input${f.num ? ' num' : ''}" id="${id}" name="${esc(f.name)}" type="text" inputmode="${f.inputmode || 'text'}" value="${esc(f.value == null ? '' : f.value)}"
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

  /** List of choices. options: [[value, label, danger?]]. Resolves the value or null. */
  function choiceSheet({ title, options }) {
    return new Promise((resolve) => {
      openSheet(`
        <h2 class="sheet-title">${esc(title)}</h2>
        <div class="list" style="margin:8px -16px 12px">
          ${options.map(([v, l, danger]) => `<button class="row" data-action="sheet-choose" data-value="${esc(v)}"${danger ? ' style="color:var(--danger)"' : ''}><span class="row-label">${esc(l)}</span></button>`).join('')}
        </div>
        <button class="btn btn-secondary btn-block" data-action="sheet-cancel">Cancel</button>`,
      { resolve, label: title });
    });
  }
  actions['sheet-choose'] = (el) => closeSheet(el.dataset.value);

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
    async render(parts) {
      if (parts[0] === 'done' && parts[1]) return renderFinished(parts[1]);
      const session = await Store.getActiveSession();
      if (!session) return renderStart();
      return renderWorkout(session);
    },
  };

  /* ================================================================== */
  /* Log tab                                                             */
  /* ================================================================== */

  const TROPHY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 1.5h8V5a4 4 0 0 1-3 3.87V11h2.5v1.5h-7V11H7V8.87A4 4 0 0 1 4 5V1.5zM1.5 2.5H3V5c0 .2 0 .4.03.6A2.5 2.5 0 0 1 1.5 3.3v-.8zm11.5 0h1.5v.8a2.5 2.5 0 0 1-1.53 2.3c.02-.2.03-.4.03-.6V2.5zM4 13.5h8V15H4z"/></svg>';

  Object.assign(state, {
    entry: null,            // the set being entered: { sessionId, exerciseId, units, weightText, exactKg, reps, rpe, note, showNote }
    dropDraft: null,        // inline drop-set row: { parentId, weightText, reps }
    nextDismissed: {},      // "sessionId|exerciseId" -> true
    startPick: null,        // session type chosen on the start screen (null = Freestyle)
    busy: false,
  });

  const todayKey = () => Store.util.dateKey();
  function prettyDate(key, long = false) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, long
      ? { weekday: 'long', day: 'numeric', month: 'long' }
      : { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const typeName = (id) => (state.sessionTypes.find((t) => t.id === id) || {}).name;
  const sessionLabel = (s) => typeName(s.sessionTypeId) || 'Freestyle';
  const mainSets = (session, exId) => session.sets.filter((s) => s.kind === 'main' && (!exId || s.exerciseId === exId));
  const dropsOf = (session, parentId) => session.sets.filter((s) => s.parentId === parentId);

  /** Weight as typed into a field: plain minus, no unit, blank for bodyweight. */
  const inputText = (kg) => (kg == null ? '' : String(Units.display(kg)));
  const weightHtml = (kg) => (kg == null ? 'BW' : `${Units.format(kg)}<small>${Units.unit}</small>`);
  const weightPlain = (kg) => (kg == null ? 'Bodyweight' : `${Units.format(kg)} ${Units.unit}`);

  /** "80 × 8, 8, 7" when the weight is the same, else "80 × 8, 82.5 × 6". */
  function setsSummary(sets) {
    if (!sets.length) return '';
    const w0 = sets[0].weightKg == null ? 0 : sets[0].weightKg;
    const same = sets.every((s) => Math.abs((s.weightKg == null ? 0 : s.weightKg) - w0) <= PRs.TOLERANCE_KG);
    if (same) return `${Units.format(sets[0].weightKg)} × ${sets.map((s) => s.reps).join(', ')}`;
    return sets.map((s) => `${Units.format(s.weightKg)} × ${s.reps}`).join(', ');
  }

  /** The most recent earlier session with main sets of this exercise. */
  function previousSessionWith(sessions, session, exId) {
    const before = (s) => s.date < session.date || (s.date === session.date && (s.startedAt || '') < (session.startedAt || ''));
    const list = sessions.filter((s) => s.id !== session.id && before(s) && mainSets(s, exId).length);
    return list[list.length - 1] || null;
  }

  /**
   * Pre-fill: the previous set of this exercise today, or else the first set
   * of last session, so a repeat set is one tap.
   */
  function ensureEntry(session, sessions, exId) {
    const e = state.entry;
    if (e && e.sessionId === session.id && e.exerciseId === exId && e.units === Units.unit) return e;
    const here = mainSets(session, exId);
    let src = here[here.length - 1];
    if (!src) {
      const prev = previousSessionWith(sessions, session, exId);
      if (prev) src = mainSets(prev, exId)[0];
    }
    state.entry = {
      sessionId: session.id,
      exerciseId: exId,
      units: Units.unit,
      exactKg: src ? src.weightKg : undefined,
      weightText: src ? inputText(src.weightKg) : '',
      reps: src ? src.reps : 8,
      rpe: null,                         // RPE starts empty for every set; it only gets a value when the slider is used
      note: '',
      showNote: false,
    };
    return state.entry;
  }

  /**
   * kg for the typed weight. If the field still shows the pre-filled value,
   * the exact stored kg is reused, so kg↔lb rounding never creates a false PR.
   */
  function entryKg(text, exactKg) {
    if (exactKg !== undefined && String(text).trim() === inputText(exactKg)) return { kg: exactKg };
    return Units.parse(text);
  }

  async function recomputeMilestones(exerciseIds) {
    const sessions = await Store.listSessions();
    for (const id of new Set(exerciseIds)) {
      await Store.replaceExerciseMilestones(id, PRs.computeMilestones(sessions, id));
    }
  }

  function clockText(session) {
    if (session.date !== todayKey()) return `Started ${prettyDate(session.date)}`;
    const sec = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  setInterval(() => {
    const el = $('[data-clock]');
    if (el && state.activeSession) el.textContent = clockText(state.activeSession);
  }, 1000);

  /* ---------- Start screen ---------- */

  async function renderStart() {
    state.activeSession = null;
    const s = state.settings;
    const types = state.sessionTypes;
    const sessions = await Store.listSessions();
    const last = sessions.filter((x) => x.finishedAt).pop();
    const dayId = s.schedule.enabled ? s.schedule.days[new Date().getDay()] : undefined;
    const todayType = dayId ? types.find((t) => t.id === dayId) : null;
    if (state.startPick && !types.some((t) => t.id === state.startPick)) state.startPick = null;
    const setsIn = (t) => t.items.reduce((n, i) => n + i.targetSets, 0);
    const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' });

    let top = '';
    if (s.schedule.enabled && todayType) {
      top = `<div class="today-card">
        <span class="when">Today · ${esc(weekday)}</span>
        <span class="what">${esc(todayType.name)}</span>
        <span class="detail">${plural(todayType.items.length, 'exercise')} · ${plural(setsIn(todayType), 'set')}</span>
        <button class="btn btn-primary btn-xl btn-block" data-action="start" data-type="${esc(todayType.id)}">Start ${esc(todayType.name)}</button>
      </div>`;
    } else if (s.schedule.enabled) {
      top = `<div class="today-card"><span class="when">Today · ${esc(weekday)}</span>
        <span class="what">Rest day</span><span class="detail">Training anyway? Pick a session below.</span></div>`;
    }
    const chipTypes = todayType ? types.filter((t) => t.id !== todayType.id) : types;

    return `${head('Log')}
      ${top}
      <section class="group" style="margin-top:${top ? 8 : 20}px">
        <h2 class="group-title">${todayType ? 'Or start something else' : 'Session (optional)'}</h2>
        <div class="chips" role="group">
          ${chipTypes.map((t) => `<button class="chip" data-action="start-pick" data-type="${esc(t.id)}" aria-pressed="${state.startPick === t.id}">${esc(t.name)}</button>`).join('')}
          <button class="chip" data-action="start-pick" data-type="" aria-pressed="${!state.startPick}">Freestyle</button>
        </div>
        ${types.length ? '' : '<p class="group-note">Set up session types like Push or Legs in Settings to get exercise suggestions. Freestyle works without one.</p>'}
      </section>
      ${last ? `<p class="last-row">Last workout: <a href="#calendar/${last.date}"><b>${esc(sessionLabel(last))}</b> · ${esc(prettyDate(last.date))}</a> · ${plural(mainSets(last).length, 'set')}</p>` : ''}
      <div class="start-bar">
        <button class="btn btn-${todayType ? 'secondary' : 'primary'} btn-xl btn-block" data-action="start-go">
          Start ${esc(state.startPick ? typeName(state.startPick) : 'freestyle')} workout</button>
      </div>`;
  }

  actions['start-pick'] = (el) => { state.startPick = el.dataset.type || null; return render({ keepScroll: true }); };
  actions['start-go'] = () => startWorkout(state.startPick);
  actions.start = (el) => startWorkout(el.dataset.type || null);

  async function startWorkout(sessionTypeId) {
    await Store.startSession({ sessionTypeId });
    Object.assign(state, { entry: null, dropDraft: null, startPick: null });
    await render({ animate: true });
  }

  /* ---------- Workout screen ---------- */

  async function renderWorkout(session) {
    state.activeSession = session;
    const sessions = await Store.listSessions();
    const prBySet = {};
    for (const m of await Store.listMilestones()) {
      if (m.sessionId === session.id) (prBySet[m.setId] = prBySet[m.setId] || []).push(m.type);
    }
    const cur = session.currentExerciseId;
    const st = state.sessionTypes.find((t) => t.id === session.sessionTypeId);
    const splitItem = st && cur ? st.items.find((i) => i.exerciseId === cur) : null;
    const curMain = cur ? mainSets(session, cur) : [];
    const strip = session.exerciseOrder.filter((id) => id === cur || mainSets(session, id).length);

    const top = `<header class="w-top">
        <span class="sess">${esc(sessionLabel(session))}</span>
        <span class="clock num" data-clock>${esc(clockText(session))}</span>
        <span class="grow"></span>
        <button class="btn-out" data-action="w-add-ex">+ Exercise</button>
        <button class="finish" data-action="w-finish">Finish</button>
      </header>`;

    const notice = session.reopenedFinishedAt ? `<div class="notice">
        <span>You are editing the workout from <b>${esc(prettyDate(session.date, true))}</b>. Tap Finish when you are done.</span>
      </div>` : session.date !== todayKey() ? `<div class="notice">
        <span>This workout started on <b>${esc(prettyDate(session.date, true))}</b> and will be saved to that day.</span>
        <button class="text-btn" data-action="move-today">Move it to today instead</button>
      </div>` : '';

    const stripHtml = strip.length > 1 ? `<nav class="ex-strip" aria-label="Exercises this session">
        ${strip.map((id) => `<button class="ex-chip" data-action="ex-switch" data-id="${esc(id)}" aria-current="${id === cur}">
          ${esc(exerciseName(id))}<span class="n">${mainSets(session, id).length}</span></button>`).join('')}
      </nav>` : '';

    if (!cur) {
      return `${top}${notice}<div class="no-ex"><strong>Pick your first exercise</strong>
        <span>Search the library or create a new one.</span>
        <button class="btn btn-primary btn-xl" data-action="w-add-ex">+ Exercise</button></div>`;
    }

    const e = ensureEntry(session, sessions, cur);
    const prev = previousSessionWith(sessions, session, cur);
    const lastTime = prev
      ? `Last time: <b>${esc(setsSummary(mainSets(prev, cur)))}</b> · ${esc(prettyDate(prev.date))}`
      : 'First time logging this exercise';
    const count = splitItem
      ? `${curMain.length}<small> / ${plural(splitItem.targetSets, 'set')}</small>`
      : `${curMain.length}<small> ${curMain.length === 1 ? 'set' : 'sets'}</small>`;

    const setsHtml = curMain.map((set, i) => {
      const drops = dropsOf(session, set.id);
      const pr = prBySet[set.id];
      const dd = state.dropDraft && state.dropDraft.parentId === set.id ? state.dropDraft : null;
      return `<div class="grp${set.id === state.justLogged ? ' enter' : ''}">
        <div class="set-row">
          <span class="n">${i + 1}</span>
          <span class="w">${weightHtml(set.weightKg)}</span><span class="x">×</span><span class="r">${set.reps}</span>
          <span class="rpe">${set.rpe != null ? `RPE ${set.rpe}` : ''}</span>
          <span>${pr ? `<span class="pr-badge" title="${pr.includes('weight') ? 'Weight PR' : 'Rep PR'}">${TROPHY}PR</span>` : ''}</span>
          <button class="row-menu" data-action="set-menu" data-id="${esc(set.id)}" data-n="${i + 1}" aria-label="Set ${i + 1} options">⋯</button>
        </div>
        ${set.note ? `<div class="set-note">${esc(set.note)}</div>` : ''}
        ${drops.map((d) => `<div class="drop-row${d.id === state.justLogged ? ' enter' : ''}">
          <span class="arrow">↳</span><span class="w">${weightHtml(d.weightKg)}</span><span class="x">×</span><span class="r">${d.reps}</span>
          <span class="tag-d">drop</span><span></span>
          <button class="row-menu" data-action="set-menu" data-id="${esc(d.id)}" aria-label="Drop set options">⋯</button></div>`).join('')}
        ${dd ? `<div class="drop-edit${dd.fresh ? ' enter' : ''}">
            <label class="visually-hidden" for="drop-w">Drop weight</label>
            <input class="input" id="drop-w" type="text" inputmode="decimal" autocomplete="off" value="${esc(dd.weightText)}" placeholder="BW" data-input="drop-w">
            <span class="unit">${Units.unit}</span>
            <div class="stepper-sm" aria-label="Drop reps">
              <button data-action="drop-reps" data-step="-1" aria-label="One fewer rep">−</button>
              <output class="num" id="drop-r">${dd.reps}</output>
              <button data-action="drop-reps" data-step="1" aria-label="One more rep">+</button>
            </div>
            <button class="btn btn-primary btn-sm" data-action="drop-save">Add drop</button>
            <button class="icon-btn" data-action="drop-cancel" aria-label="Cancel drop set">${ICON.x}</button>
          </div>`
          : `<div class="drop-add"><button data-action="drop-open" data-id="${esc(set.id)}">+ Drop</button></div>`}
      </div>`;
    }).join('');

    // Next exercise card: target reached and something in the split is still undone.
    let nextHtml = '';
    if (splitItem && curMain.length >= splitItem.targetSets && !state.nextDismissed[`${session.id}|${cur}`]) {
      const next = st.items.find((i) => i.exerciseId !== cur && !mainSets(session, i.exerciseId).length);
      if (next) {
        const key = `${session.id}|${cur}|${next.exerciseId}`;
        const fresh = state.nextSeen !== key;
        state.nextSeen = key;
        nextHtml = `<div class="next-card${fresh ? ' enter' : ''}">
          <div class="t">Next: <b>${esc(exerciseName(next.exerciseId))}</b> <span>· ${plural(next.targetSets, 'set')}</span></div>
          <button class="keep" data-action="next-keep" data-id="${esc(next.exerciseId)}">Keep</button>
          <button class="icon-btn" data-action="next-dismiss" aria-label="Hide suggestion">${ICON.x}</button>
        </div>`;
      }
    }

    const rpe = state.settings.rpeEnabled ? `
      <div>
        <div class="rpe-row${e.rpe == null ? ' empty' : ''}">
          <label for="rpe-in">RPE</label>
          <input id="rpe-in" type="range" min="5.5" max="10" step="0.5" value="${e.rpe == null ? 5.5 : e.rpe}" data-input="rpe-in"
            aria-valuetext="${e.rpe == null ? 'No RPE' : `RPE ${e.rpe}`}">
          <output class="num" id="rpe-out" for="rpe-in">${e.rpe == null ? '—' : e.rpe}</output>
        </div>
        <div class="rpe-ticks">${['—', 6, 7, 8, 9, 10].map((t, i) => `<span style="--f:${i === 0 ? 0 : (t - 5.5) / 4.5}">${t}</span>`).join('')}</div>
      </div>` : '';

    return `${top}${notice}${stripHtml}
      <div class="ex-head">
        <div class="row1"><h2>${esc(exerciseName(cur))}</h2><span class="count">${count}</span></div>
        <div class="last">${lastTime}</div>
      </div>
      ${curMain.length ? `<div class="sets">${setsHtml}</div>` : ''}
      ${nextHtml}
      <div class="entry">
        <div class="corner-slot" data-corner-slot>${cornerTimerHtml()}</div>
        <div data-rest-slot>${restRowHtml()}</div>
        <div class="fields">
          <div>
            <label class="lab" for="w-in">Weight <em>blank = BW</em></label>
            <div class="w-input">
              <input id="w-in" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${esc(e.weightText)}" placeholder="BW" data-input="w-in">
              <span class="unit">${Units.unit}</span>
              <button class="sign" data-action="w-sign" aria-label="Switch between added weight and assistance">±</button>
            </div>
          </div>
          <div>
            <span class="lab">Reps</span>
            <div class="reps">
              <button data-action="reps-step" data-step="-1" aria-label="One fewer rep">−</button>
              <output id="reps-out" aria-live="polite">${e.reps}</output>
              <button data-action="reps-step" data-step="1" aria-label="One more rep">+</button>
            </div>
          </div>
        </div>
        ${rpe}
        <div class="note-row">${e.showNote
          ? `<label class="visually-hidden" for="note-in">Note for this set</label>
             <input class="input" id="note-in" type="text" autocomplete="off" placeholder="Note for this set" value="${esc(e.note)}" data-input="note-in">`
          : '<button class="text-btn" data-action="note-open">+ note</button>'}
          <button class="text-btn plates-btn" data-action="plates">Plates</button></div>
        <button class="log-btn" data-action="log-set">Log set ${curMain.length + 1}</button>
      </div>`;
  }

  /* ---------- Entry controls ---------- */

  inputs['w-in'] = (el) => { state.entry.weightText = el.value; };
  inputs['note-in'] = (el) => { state.entry.note = el.value; };
  // The far-left position (5.5) means "no RPE"; 6 to 10 are values.
  inputs['rpe-in'] = (el) => {
    const v = Number(el.value);
    state.entry.rpe = v < 6 ? null : v;
    $('#rpe-out').textContent = state.entry.rpe == null ? '—' : String(v);
    el.setAttribute('aria-valuetext', state.entry.rpe == null ? 'No RPE' : `RPE ${v}`);
    el.closest('.rpe-row').classList.toggle('empty', state.entry.rpe == null);
  };
  actions['reps-step'] = (el) => {
    const e = state.entry;
    e.reps = Math.min(999, Math.max(1, e.reps + Number(el.dataset.step)));
    $('#reps-out').textContent = e.reps;
    bump($('#reps-out'));
  };
  actions['w-sign'] = () => {
    const e = state.entry;
    const t = e.weightText.trim();
    if (!t || t === '0') return;
    e.weightText = t.startsWith('-') ? t.slice(1) : `-${t}`;
    $('#w-in').value = e.weightText;
  };
  actions['note-open'] = async () => {
    state.entry.showNote = true;
    await render({ keepScroll: true });
    const n = $('#note-in');
    if (n) n.focus();
  };

  actions['log-set'] = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const session = await Store.getActiveSession();
      const e = state.entry;
      const w = entryKg(e.weightText, e.exactKg);
      if (w.error) throw new Error(w.error);
      const set = await Store.addSet(session.id, {
        exerciseId: e.exerciseId,
        weightKg: w.kg,
        reps: e.reps,
        rpe: state.settings.rpeEnabled ? e.rpe : null,
        note: e.showNote ? e.note : '',
      });
      const found = PRs.milestonesForSet(await Store.listSessions(), set.exerciseId, set.id);
      if (found.length) {
        await Store.addMilestones(found);
        showPrBanner(found[0]);
      } else if (navigator.vibrate) {
        navigator.vibrate(15);
      }
      Object.assign(e, { exactKg: set.weightKg, weightText: inputText(set.weightKg), note: '', showNote: false, rpe: null });
      const rt = state.settings.restTimer;
      if (rt.enabled && rt.autoStart) timerStart(rt.durationSec);
      else if (timer.done) timerStop();
      state.justLogged = set.id;               // slides the new row in
      await render({ keepScroll: true });
      state.justLogged = null;
      const v = $('#view');
      v.scrollTo({ top: v.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    } finally {
      state.busy = false;
    }
  };

  /* ---------- Exercises in the session ---------- */

  async function setCurrentExercise(id) {
    const session = await Store.getActiveSession();
    await Store.updateSession(session.id, { currentExerciseId: id });
    state.dropDraft = null;
    await render({ animate: true });
  }
  actions['ex-switch'] = (el) => setCurrentExercise(el.dataset.id);
  actions['next-keep'] = (el) => setCurrentExercise(el.dataset.id);
  actions['next-dismiss'] = async () => {
    const s = state.activeSession;
    state.nextDismissed[`${s.id}|${s.currentExerciseId}`] = true;
    await render({ keepScroll: true });
  };
  actions['w-add-ex'] = async () => {
    const id = await pickExercise({ title: 'Add exercise' });
    if (id) await setCurrentExercise(id);
  };
  actions['move-today'] = async () => {
    const s = await Store.getActiveSession();
    await Store.updateSession(s.id, { date: todayKey() });
    await recomputeMilestones(s.sets.map((x) => x.exerciseId));
    await render({ keepScroll: true });
    toast('Moved to today');
  };

  /* ---------- Edit / delete sets ---------- */

  actions['set-menu'] = async (el) => {
    const session = await Store.getActiveSession();
    const set = session.sets.find((x) => x.id === el.dataset.id);
    if (!set) return;
    const label = `${set.kind === 'drop' ? 'Drop set' : `Set ${el.dataset.n}`} · ${weightPlain(set.weightKg)} × ${set.reps}`;
    const choice = await choiceSheet({ title: label, options: [['edit', 'Edit'], ['delete', 'Delete', true]] });
    if (choice === 'edit') await editSet(session, set);
    if (choice === 'delete') await deleteSet(session, set);
  };

  async function editSet(session, set) {
    const isMain = set.kind === 'main';
    const rpeOptions = [['', 'None'], ...[6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((v) => [String(v), String(v)])];
    const fields = [
      { name: 'weight', label: `Weight (${Units.unit}, blank = bodyweight)`, value: inputText(set.weightKg), inputmode: 'decimal', num: true },
      { name: 'reps', label: 'Reps', value: String(set.reps), inputmode: 'numeric', num: true },
    ];
    if (isMain && (state.settings.rpeEnabled || set.rpe != null)) {
      fields.push({ name: 'rpe', label: 'RPE', type: 'select', value: set.rpe == null ? '' : String(set.rpe), options: rpeOptions });
    }
    if (isMain) fields.push({ name: 'note', label: 'Note', value: set.note });
    const done = await formSheet({
      title: isMain ? 'Edit set' : 'Edit drop set',
      fields,
      onSubmit: async (v) => {
        const w = entryKg(v.weight, set.weightKg);
        if (w.error) throw new Error(w.error);
        const reps = Number(v.reps);
        if (!Number.isInteger(reps) || reps < 1) throw new Error('Reps must be a whole number of 1 or more.');
        const patch = { weightKg: w.kg, reps };
        if ('rpe' in v) patch.rpe = v.rpe === '' ? null : Number(v.rpe);
        if ('note' in v) patch.note = v.note;
        return Store.updateSet(session.id, set.id, patch);
      },
    });
    if (!done) return;
    await recomputeMilestones([set.exerciseId]);
    await render({ keepScroll: true });
    toast('Set updated');
  }

  /** Deletes straight away and offers Undo for a few seconds instead of asking first. */
  async function deleteSet(session, set) {
    const removed = session.sets
      .map((x, index) => ({ set: x, index }))
      .filter(({ set: x }) => x.id === set.id || x.parentId === set.id);
    await Store.deleteSet(session.id, set.id);
    if (state.dropDraft && state.dropDraft.parentId === set.id) state.dropDraft = null;
    await recomputeMilestones([set.exerciseId]);
    await render({ keepScroll: true });
    const drops = removed.length - 1;
    const what = set.kind === 'drop' ? 'Drop set deleted' : drops ? `Set and ${plural(drops, 'drop')} deleted` : 'Set deleted';
    toast(what, {
      action: {
        label: 'Undo',
        run: async () => {
          await Store.restoreSets(session.id, removed);
          await recomputeMilestones([set.exerciseId]);
          await render({ keepScroll: true });
          toast('Set restored');
        },
      },
    });
  }

  /* ---------- Drop sets ---------- */

  actions['drop-open'] = async (el) => {
    const session = await Store.getActiveSession();
    const parent = session.sets.find((x) => x.id === el.dataset.id);
    const drops = dropsOf(session, parent.id);
    const base = drops.length ? drops[drops.length - 1] : parent;
    let text = '';
    if (base.weightKg != null && base.weightKg > 0) {
      const step = Units.unit === 'lb' ? 5 : 2.5;
      const v = Math.round((Units.display(base.weightKg) * 0.8) / step) * step;
      text = v > 0 ? String(v) : '';
    }
    state.dropDraft = { parentId: parent.id, weightText: text, reps: base.reps, fresh: true };
    await render({ keepScroll: true });
    state.dropDraft.fresh = false;
  };
  inputs['drop-w'] = (el) => { state.dropDraft.weightText = el.value; };
  actions['drop-reps'] = (el) => {
    const d = state.dropDraft;
    d.reps = Math.min(999, Math.max(1, d.reps + Number(el.dataset.step)));
    $('#drop-r').textContent = d.reps;
    bump($('#drop-r'));
  };
  actions['drop-cancel'] = () => { state.dropDraft = null; return render({ keepScroll: true }); };
  actions['drop-save'] = async () => {
    const d = state.dropDraft;
    const w = Units.parse(d.weightText);
    if (w.error) throw new Error(w.error);
    const session = await Store.getActiveSession();
    const drop = await Store.addSet(session.id, { parentId: d.parentId, weightKg: w.kg, reps: d.reps });
    state.dropDraft = null;
    const rt = state.settings.restTimer;
    if (rt.enabled && rt.autoStart) timerStart(rt.durationSec);
    state.justLogged = drop.id;
    await render({ keepScroll: true });
    state.justLogged = null;
  };


  /* ---------- Plate calculator ---------- */
  /* Plates per side for the weight in the entry field, on a bar the user picks. */

  const PLATES = { kg: [25, 20, 15, 10, 5, 2.5, 1.25], lb: [45, 35, 25, 10, 5, 2.5] };
  const BARS = { kg: [20, 15, 10], lb: [45, 35, 25] };
  const PLATE_SIZE = { 25: 1, 20: 0.92, 15: 0.82, 10: 0.7, 5: 0.54, 2.5: 0.42, 1.25: 0.34, 45: 1, 35: 0.88 };

  /** Greedy split of one side into plates. Returns { plates, rest } in display units. */
  function platesFor(total, bar, unit) {
    let side = Math.round(((total - bar) / 2) * 1000) / 1000;
    const plates = [];
    for (const p of PLATES[unit]) {
      while (side >= p - 1e-6) { plates.push(p); side = Math.round((side - p) * 1000) / 1000; }
    }
    return { plates, rest: side };
  }

  function platesHtml() {
    const unit = Units.unit;
    const bar = (state.settings.plateBar || {})[unit] || BARS[unit][0];
    const parsed = entryKg(state.entry.weightText, state.entry.exactKg);
    const total = parsed.kg == null ? null : Units.display(parsed.kg);
    const fmt = (n) => String(Math.round(n * 100) / 100);
    let body;
    if (parsed.error) body = `<p class="sheet-body">${esc(parsed.error)}</p>`;
    else if (total == null || total <= 0) body = '<p class="sheet-body">Type a weight above 0 to see the plates. Blank means bodyweight, and negative means assisted.</p>';
    else if (total < bar - 1e-6) body = `<p class="sheet-body">${fmt(total)} ${unit} is lighter than a ${fmt(bar)} ${unit} bar.</p>`;
    else {
      const { plates, rest } = platesFor(total, bar, unit);
      const exact = rest < 0.01;
      const loaded = bar + 2 * plates.reduce((a, b) => a + b, 0);
      // Side view of one half of the bar: sleeve with plates from the collar outward.
      let x = 34;
      const rects = plates.map((p) => {
        const h = 92 * (PLATE_SIZE[p] || 0.4);
        const w = p >= 10 ? 13 : 9;
        const r = `<rect class="plate" x="${x}" y="${(60 - h / 2).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="1.5"/>
          <text class="plate-label" x="${x + w / 2}" y="${(60 + h / 2 + 12).toFixed(1)}">${fmt(p)}</text>`;
        x += Math.max(w + 3, 24);           // leave room for each label underneath
        return r;
      }).join('');
      body = `
        <svg class="plates-svg" viewBox="0 0 280 124" role="img" aria-label="One side of the bar: ${plates.length ? plates.map(fmt).join(', ') : 'no plates'}">
          <rect class="bar-shaft" x="0" y="57" width="30" height="6"/>
          <rect class="bar-collar" x="28" y="50" width="5" height="20"/>
          <rect class="bar-sleeve" x="33" y="56" width="${Math.max(120, x - 20)}" height="8"/>
          ${rects}
        </svg>
        <p class="plates-line"><b>Each side:</b> <span class="num">${plates.length ? plates.map(fmt).join(' + ') : 'nothing, just the bar'}</span></p>
        <p class="plates-line muted num">${fmt(bar)} bar${plates.length ? ` + 2 × ${fmt((loaded - bar) / 2)}` : ''} = ${fmt(loaded)} ${unit}</p>
        ${exact ? '' : `<p class="plates-line" style="color:var(--danger)">${fmt(total)} ${unit} can't be loaded exactly with standard plates. Closest below is ${fmt(loaded)} ${unit}.</p>`}`;
    }
    return `<h2 class="sheet-title">Plates${total > 0 ? ` for <span class="num">${fmt(total)} ${unit}</span>` : ''}</h2>
      <div class="row" style="padding:4px 0 10px;border:0;min-height:0"><span class="row-label">Bar</span>
        ${seg('plates-bar', String(bar), BARS[unit].map((b) => [String(b), `${b} ${unit}`]))}</div>
      ${body}
      <button class="btn btn-secondary btn-block" data-action="sheet-cancel" style="margin-top:14px">Close</button>`;
  }

  actions.plates = () => new Promise((resolve) => openSheet(platesHtml(), { resolve, label: 'Plate calculator' }));
  actions['plates-bar'] = async (el) => {
    const plateBar = { ...(state.settings.plateBar || {}), [Units.unit]: Number(el.dataset.value) };
    state.settings = await Store.updateSettings({ plateBar });
    const sheetEl = $('#sheet-root .sheet');
    if (sheetEl) sheetEl.innerHTML = platesHtml();
  };

  /* ---------- PR banner ---------- */

  let prTimer = null;
  function showPrBanner(m) {
    const name = exerciseName(m.exerciseId);
    const title = m.type === 'weight' ? `Weight PR · ${name}` : `Rep PR · ${name}`;
    const prevText = m.type === 'weight'
      ? `Heaviest before: ${weightPlain(m.previous.weightKg)}`
      : `Best before: ${plural(m.previous.reps, 'rep')} at ${weightPlain(m.previous.weightKg)}`;
    $('#pr-banner').innerHTML = `<button class="pr-pop" data-action="pr-dismiss">${TROPHY}
      <span class="t"><b>${esc(title)}</b><span class="num">${esc(weightPlain(m.weightKg))} × ${m.reps} · ${esc(prevText)}</span></span></button>`;
    if (navigator.vibrate) navigator.vibrate([60, 60, 120]);
    clearTimeout(prTimer);
    prTimer = setTimeout(() => { $('#pr-banner').innerHTML = ''; }, 5000);
  }
  actions['pr-dismiss'] = () => { clearTimeout(prTimer); $('#pr-banner').innerHTML = ''; };

  /* ---------- Timers: rest countdown and stopwatch ---------- */
  /*
   * Where the timer lives is a setting (restTimer.placement):
   *   'panel'  a row at the top of the set-entry block (the original layout)
   *   'corner' a small hourglass in the bottom-right corner above the entry block
   * Both open the same timer panel, which has two tabs: Rest and Stopwatch
   * (the stopwatch is for timed holds such as planks; its time can go into the set note).
   */

  const timer = { running: false, done: false, startAt: 0, endAt: 0, total: 0, interval: null, wake: null, overlay: false, tab: 'rest', nextSec: 0 };
  const watch = { running: false, startAt: 0, acc: 0 };

  const watchMs = () => watch.acc + (watch.running ? Date.now() - watch.startAt : 0);
  const watchText = () => {
    const ms = watchMs();
    const sec = Math.floor(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  };
  const watchShort = () => fmtDuration(Math.floor(watchMs() / 1000));

  /** Analog dial. mode 'rest': the arc shows rest left. mode 'watch': the arc fills once a minute. */
  function dialSvg(cls, mode = 'rest') {
    const parts = [];
    for (let i = 0; i < 60; i++) {
      const a = (i * 6 * Math.PI) / 180;
      const major = i % 5 === 0;
      const r1 = 88;
      const r2 = major ? 79 : 84;
      const f = (n) => n.toFixed(2);
      parts.push(`<line class="tick${major ? ' major' : ''}" x1="${f(100 + r1 * Math.sin(a))}" y1="${f(100 - r1 * Math.cos(a))}" x2="${f(100 + r2 * Math.sin(a))}" y2="${f(100 - r2 * Math.cos(a))}"/>`);
    }
    for (let n = 0; n < 60; n += 10) {
      const a = (n * 6 * Math.PI) / 180;
      parts.push(`<text class="numeral" x="${(100 + 68 * Math.sin(a)).toFixed(1)}" y="${(100 - 68 * Math.cos(a)).toFixed(1)}">${n}</text>`);
    }
    return `<svg class="dial ${cls}" viewBox="0 0 200 200" aria-hidden="true" data-dial="${mode}">
      <circle class="face" cx="100" cy="100" r="99"/>
      <circle class="track" cx="100" cy="100" r="94"/>
      <circle class="arc" cx="100" cy="100" r="94" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 100 100)" data-arc/>
      ${parts.join('')}
      <text class="readout" x="100" y="128" data-readout></text>
      <text class="caption" x="100" y="152">${mode === 'watch' ? 'elapsed' : 'rest left'}</text>
      <g data-hand><line class="hand" x1="100" y1="114" x2="100" y2="16"/></g>
      <rect class="hub" x="95" y="95" width="10" height="10"/>
      <rect class="hub-in" x="98.5" y="98.5" width="3" height="3"/>
    </svg>`;
  }

  /** Hourglass with sand in the theme colour; paintTimer() moves the sand. */
  function hourglassSvg() {
    return `<svg class="hourglass" viewBox="0 0 24 32" aria-hidden="true">
      <defs>
        <clipPath id="hg-top"><path d="M7 4h10v2c0 4.5-3 7.5-5 9.5C10 13.5 7 10.5 7 6z"/></clipPath>
        <clipPath id="hg-bot"><path d="M12 16.5c2 2 5 5 5 9.5v2H7v-2c0-4.5 3-7.5 5-9.5z"/></clipPath>
      </defs>
      <rect class="sand" clip-path="url(#hg-top)" x="6" width="12" y="4" height="11.5" data-sand-top/>
      <rect class="sand" clip-path="url(#hg-bot)" x="6" width="12" y="28" height="0" data-sand-bot/>
      <line class="stream" x1="12" y1="15.5" x2="12" y2="27.5"/>
      <path class="glass" d="M6 3h12v3c0 5-4 8-5.5 10C14 18 18 21 18 26v3H6v-3c0-5 4-8 5.5-10C10 14 6 11 6 6z"/>
      <rect class="cap" x="3" y="1" width="18" height="2.2"/>
      <rect class="cap" x="3" y="28.8" width="18" height="2.2"/>
    </svg>`;
  }

  const timerLeft = () => Math.max(0, timer.endAt - Date.now());
  const timerLeftText = () => fmtDuration(Math.ceil(timerLeft() / 1000));
  const restSecs = () => timer.nextSec || state.settings.restTimer.durationSec;
  const ICON_WATCH = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="11.5" r="6.5"/><path d="M10 11.5V8M8 2.5h4M15.5 5.5l1.2-1.2"/></svg>';

  /** The row at the top of the entry block (placement 'panel'). */
  function restRowHtml() {
    const rt = state.settings.restTimer;
    if (!rt.enabled || rt.placement === 'corner') return '';
    if (timer.running || timer.done) {
      return `<div class="rest-row${timer.done ? ' done' : ''}">
        <button data-action="timer-open" data-tab="rest" aria-label="Show rest timer">${dialSvg('dial-mini')}</button>
        <span class="label">${timer.done ? 'Rest over' : 'Resting'}<b data-timer-text>${timer.done ? '0:00' : timerLeftText()}</b></span>
        ${timer.done
          ? '<button class="btn btn-secondary btn-sm" data-action="timer-stop">Dismiss</button>'
          : `<button class="btn btn-secondary btn-sm" data-action="timer-add" data-step="15">+15s</button>
             <button class="btn btn-secondary btn-sm" data-action="timer-stop">Skip</button>`}
      </div>`;
    }
    if (watch.running || watch.acc) {
      return `<div class="rest-row">
        <button class="icon-btn" data-action="timer-open" data-tab="watch" aria-label="Show stopwatch">${ICON_WATCH}</button>
        <span class="label">Stopwatch<b data-watch-text>${watchShort()}</b></span>
        <button class="btn btn-secondary btn-sm" data-action="timer-open" data-tab="watch">Open</button>
        ${watch.running ? '<button class="btn btn-secondary btn-sm" data-action="watch-stop">Stop</button>'
          : '<button class="btn btn-secondary btn-sm" data-action="watch-reset">Clear</button>'}
      </div>`;
    }
    return `<div class="rest-row"><span class="label">Rest timer<b>${fmtDuration(rt.durationSec)}</b></span>
      <button class="icon-btn" data-action="timer-open" data-tab="watch" aria-label="Stopwatch">${ICON_WATCH}</button>
      <button class="btn btn-secondary btn-sm" data-action="timer-start">Start rest</button></div>`;
  }

  /** The hourglass button (placement 'corner'), shown above the entry block. */
  function cornerTimerHtml() {
    const rt = state.settings.restTimer;
    if (!rt.enabled || rt.placement !== 'corner') return '';
    return `<button class="corner-timer${timer.done ? ' done' : ''}${timer.running || watch.running ? ' running' : ''}"
      data-action="timer-open" data-tab="${watch.running && !timer.running ? 'watch' : 'rest'}" aria-label="Timer">
      ${hourglassSvg()}<span class="t num" data-corner-text></span></button>`;
  }

  function paintTimer() {
    const left = timerLeft();
    const elapsed = (Date.now() - timer.startAt) / 1000;
    const restFrac = timer.done ? 0 : timer.running ? Math.min(1, left / (timer.total * 1000)) : 1;
    const wsec = watchMs() / 1000;
    $$('[data-dial]').forEach((svg) => {
      const isWatch = svg.dataset.dial === 'watch';
      const frac = isWatch ? (wsec % 60) / 60 : restFrac;
      svg.querySelector('[data-arc]').setAttribute('stroke-dasharray', `${(frac * 100).toFixed(2)} 100`);
      const angle = isWatch ? (wsec % 60) * 6 : (timer.done || !timer.running ? 0 : (elapsed % 60) * 6);
      svg.querySelector('[data-hand]').setAttribute('transform', `rotate(${angle.toFixed(1)} 100 100)`);
      svg.querySelector('[data-readout]').textContent = isWatch ? watchText()
        : timer.done ? '0:00' : timer.running ? timerLeftText() : fmtDuration(restSecs());
    });
    $$('[data-timer-text]').forEach((el) => { el.textContent = timer.done ? '0:00' : timerLeftText(); });
    $$('[data-watch-text]').forEach((el) => { el.textContent = watchShort(); });
    // Hourglass: rest drains the top bulb over the rest time; the stopwatch trickles once a minute.
    const hg = $('.corner-timer');
    if (hg) {
      const usingWatch = !timer.running && !timer.done && (watch.running || watch.acc > 0);
      const sandLeft = usingWatch ? 1 - (wsec % 60) / 60 : restFrac;
      const topY = 4 + (1 - sandLeft) * 11.5;
      hg.querySelector('[data-sand-top]').setAttribute('y', topY.toFixed(2));
      hg.querySelector('[data-sand-top]').setAttribute('height', (15.5 - topY).toFixed(2));
      const botH = (1 - sandLeft) * 11.5;
      hg.querySelector('[data-sand-bot]').setAttribute('y', (28 - botH).toFixed(2));
      hg.querySelector('[data-sand-bot]').setAttribute('height', botH.toFixed(2));
      hg.querySelector('[data-corner-text]').textContent = timer.running ? timerLeftText()
        : timer.done ? '0:00' : usingWatch ? watchShort() : '';
    }
  }

  function refreshRestUi() {
    const slot = $('[data-rest-slot]');
    if (slot) slot.innerHTML = restRowHtml();
    const corner = $('[data-corner-slot]');
    if (corner) corner.innerHTML = cornerTimerHtml();
    renderOverlay();
    paintTimer();
  }

  function renderOverlay() {
    const ov = $('#timer-overlay');
    if (!timer.overlay) { ov.hidden = true; ov.innerHTML = ''; return; }
    const tab = timer.done ? 'rest' : timer.tab;
    ov.hidden = false;
    let body;
    if (tab === 'rest') {
      let controls;
      if (timer.done) {
        controls = '<button class="btn btn-primary btn-block" data-action="timer-stop">Back to it</button>';
      } else if (timer.running) {
        controls = `<div class="btns">
            <button class="btn btn-secondary" data-action="timer-add" data-step="-15">−15s</button>
            <button class="btn btn-secondary" data-action="timer-add" data-step="15">+15s</button>
            <button class="btn btn-secondary" data-action="timer-stop">Skip</button>
          </div>`;
      } else {
        controls = `<div class="btns">
            <button class="btn btn-secondary" data-action="timer-add" data-step="-15">−15s</button>
            <button class="btn btn-primary" data-action="timer-start">Start</button>
            <button class="btn btn-secondary" data-action="timer-add" data-step="15">+15s</button>
          </div>`;
      }
      body = `${dialSvg('dial-big', 'rest')}
        <span class="title">${timer.done ? 'Rest over' : timer.running ? 'Resting' : 'Rest'}</span>${controls}`;
    } else {
      const has = watch.running || watch.acc > 0;
      const controls = watch.running
        ? `<button class="btn btn-secondary" data-action="watch-reset">Reset</button>
           <button class="btn btn-primary" data-action="watch-stop">Stop</button>
           <button class="btn btn-secondary" disabled>To note</button>`
        : `<button class="btn btn-secondary" data-action="watch-reset" ${has ? '' : 'disabled'}>Reset</button>
           <button class="btn btn-primary" data-action="watch-start">${has ? 'Resume' : 'Start'}</button>
           <button class="btn btn-secondary" data-action="watch-note" ${has && state.entry && state.activeSession ? '' : 'disabled'}>To note</button>`;
      body = `${dialSvg('dial-big', 'watch')}
        <span class="title">Stopwatch</span>
        <div class="btns">${controls}</div>`;
    }
    ov.innerHTML = `<div class="timer-panel${timer.done ? ' done' : ''}" role="dialog" aria-label="Timer">
      ${timer.done ? '' : `<div class="seg timer-tabs" role="group">
        <button data-action="timer-tab" data-tab="rest" aria-pressed="${tab === 'rest'}">Rest</button>
        <button data-action="timer-tab" data-tab="watch" aria-pressed="${tab === 'watch'}">Stopwatch</button>
      </div>`}
      ${body}
      ${timer.done ? '' : '<button class="text-btn" data-action="timer-hide">Hide</button>'}
    </div>`;
  }

  async function wakeOn() {
    try { if ('wakeLock' in navigator && !timer.wake) timer.wake = await navigator.wakeLock.request('screen'); } catch (_) { /* not allowed */ }
  }
  function wakeOff() {
    if (timer.wake && !timer.running && !watch.running) { timer.wake.release().catch(() => {}); timer.wake = null; }
  }
  function ensureTicking() {
    clearInterval(timer.interval);
    if (timer.running || watch.running) timer.interval = setInterval(timerTick, watch.running ? 100 : 200);
  }

  function timerStart(sec) {
    Object.assign(timer, { running: true, done: false, startAt: Date.now(), endAt: Date.now() + sec * 1000, total: sec, nextSec: 0 });
    ensureTicking();
    wakeOn();
    refreshRestUi();
  }
  function timerTick() {
    if (timer.running && timerLeft() <= 0) {
      timer.running = false;
      timer.done = true;
      timer.overlay = true;
      ensureTicking();
      if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
      setTimeout(wakeOff, 15000);
      refreshRestUi();
      return;
    }
    paintTimer();
  }
  function timerStop() {
    Object.assign(timer, { running: false, done: false, overlay: false, nextSec: 0 });
    ensureTicking();
    wakeOff();
    refreshRestUi();
  }

  actions['timer-start'] = () => timerStart(restSecs());
  actions['timer-stop'] = () => timerStop();
  actions['timer-open'] = (el) => { timer.overlay = true; timer.tab = el.dataset.tab || 'rest'; renderOverlay(); paintTimer(); };
  actions['timer-hide'] = () => { timer.overlay = false; renderOverlay(); };
  actions['timer-tab'] = (el) => { timer.tab = el.dataset.tab; renderOverlay(); paintTimer(); };
  actions['timer-add'] = (el) => {
    const d = Number(el.dataset.step);
    if (!timer.running) {                       // before starting: adjust this rest only
      timer.nextSec = Math.min(600, Math.max(15, restSecs() + d));
      paintTimer();
      return;
    }
    timer.endAt = Math.max(Date.now() + 1000, timer.endAt + d * 1000);
    timer.total = Math.max(1, timer.total + d);
    paintTimer();
  };
  actions['watch-start'] = () => {
    Object.assign(watch, { running: true, startAt: Date.now() });
    ensureTicking();
    wakeOn();
    refreshRestUi();
  };
  actions['watch-stop'] = () => {
    if (watch.running) Object.assign(watch, { running: false, acc: watch.acc + (Date.now() - watch.startAt) });
    ensureTicking();
    wakeOff();
    refreshRestUi();
  };
  actions['watch-reset'] = () => {
    Object.assign(watch, { running: false, startAt: 0, acc: 0 });
    ensureTicking();
    wakeOff();
    refreshRestUi();
  };
  /** Puts the stopwatch time into the note of the set being entered, e.g. "Held 0:45". */
  actions['watch-note'] = async () => {
    if (!state.entry) return;
    const text = `Held ${watchShort()}`;
    state.entry.note = state.entry.note ? `${state.entry.note} · ${text}` : text;
    state.entry.showNote = true;
    timer.overlay = false;
    renderOverlay();
    await render({ keepScroll: true });
    toast(`Added "${text}" to the note`);
  };
  $('#timer-overlay').addEventListener('click', (ev) => {
    if (ev.target.id !== 'timer-overlay') return;
    if (timer.done) timerStop();
    else { timer.overlay = false; renderOverlay(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (timer.running || watch.running) { wakeOn(); timerTick(); }
    }
  });

  /* ---------- Finish ---------- */

  actions['w-finish'] = async () => {
    const s = await Store.getActiveSession();
    const n = mainSets(s).length;
    if (!n) {
      const ok = await confirmSheet({
        title: 'Discard this workout?',
        body: 'No sets were logged, so there is nothing to save.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      await Store.deleteSession(s.id);
      timerStop();
      Object.assign(state, { entry: null, dropDraft: null });
      await render();
      return;
    }
    const ok = await confirmSheet({
      title: 'Finish workout?',
      body: `${plural(n, 'set')} will be saved to ${prettyDate(s.date, true)}.`,
      confirmLabel: 'Finish',
    });
    if (!ok) return;
    await Store.finishSession(s.id);
    timerStop();
    Object.assign(state, { entry: null, dropDraft: null });
    go(`#log/done/${encodeURIComponent(s.id)}`);
  };

  function durationText(s) {
    const min = Math.round((new Date(s.finishedAt) - new Date(s.startedAt)) / 60000);
    if (!(min >= 0) || min > 12 * 60) return '—';
    return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
  }

  async function renderFinished(id) {
    state.activeSession = null;
    const s = await Store.getSession(id);
    if (!s) return `${head('Log')}<p class="empty">That workout no longer exists.</p>`;
    const ms = (await Store.listMilestones()).filter((m) => m.sessionId === id);
    const bws = await Store.listBodyweights();
    const mine = bws.find((b) => b.sessionId === id);
    const latest = bws[bws.length - 1];
    const main = mainSets(s);
    const drops = s.sets.length - main.length;
    const exIds = s.exerciseOrder.filter((x) => mainSets(s, x).length);
    return `${head('Workout saved')}
      <p class="sum-date"><b>${esc(sessionLabel(s))}</b> · ${esc(prettyDate(s.date, true))}</p>
      <div class="stats">
        <div><b>${main.length}</b><span>${main.length === 1 ? 'set' : 'sets'}</span></div>
        <div><b>${exIds.length}</b><span>${exIds.length === 1 ? 'exercise' : 'exercises'}</span></div>
        <div><b>${ms.length}</b><span>${ms.length === 1 ? 'PR' : 'PRs'}</span></div>
        <div><b>${esc(durationText(s))}</b><span>time</span></div>
      </div>
      ${ms.length ? `<section class="group sum-list"><h2 class="group-title">PRs hit</h2><div class="list">
        ${ms.map((m) => `<div class="row pr-line">${TROPHY}<span class="row-label">${esc(exerciseName(m.exerciseId))}
          <small>${m.type === 'weight' ? 'Weight PR' : 'Rep PR'}</small></span>
          <span class="num-r">${esc(weightPlain(m.weightKg))} × ${m.reps}</span></div>`).join('')}
      </div></section>` : ''}
      <section class="group sum-list"><h2 class="group-title">Exercises</h2><div class="list">
        ${exIds.map((x) => {
          const sets = mainSets(s, x);
          const d = s.sets.filter((y) => y.kind === 'drop' && y.exerciseId === x).length;
          return `<div class="row"><span class="row-label">${esc(exerciseName(x))}<small class="num">${esc(setsSummary(sets))}</small></span>
            <span class="num-r">${plural(sets.length, 'set')}${d ? ` + ${d} drop` : ''}</span></div>`;
        }).join('')}
      </div>${drops ? `<p class="group-note">${plural(drops, 'drop set')} not counted as sets.</p>` : ''}</section>
      <section class="group">
        <h2 class="group-title">Bodyweight (optional)</h2>
        <div class="page-pad" style="padding-top:0">
          <div class="bw-form">
            <div class="field">
              <label class="visually-hidden" for="bw-in">Bodyweight</label>
              <div class="w-input"><input id="bw-in" type="text" inputmode="decimal" autocomplete="off"
                value="${mine ? esc(inputText(mine.kg)) : ''}" placeholder="${latest ? esc(inputText(latest.kg)) : ''}"><span class="unit">${Units.unit}</span></div>
            </div>
            <button class="btn btn-secondary" data-action="bw-save" data-session="${esc(id)}">${mine ? 'Update' : 'Save'}</button>
          </div>
        </div>
      </section>
      <div class="actions-bar"><a class="btn btn-primary btn-xl btn-block" href="#log">Done</a></div>`;
  }

  actions['bw-save'] = async (el) => {
    const w = Units.parse($('#bw-in').value);
    if (w.error || w.kg == null || w.kg <= 0) throw new Error('Enter your bodyweight as a number.');
    await Store.logBodyweight({ sessionId: el.dataset.session, kg: w.kg });
    await render({ keepScroll: true });
    toast('Bodyweight saved');
  };

  /* ================================================================== */
  /* Calendar tab                                                        */
  /* Routes: #calendar (this month), #calendar/YYYY-MM, #calendar/YYYY-MM-DD */
  /* ================================================================== */

  screens.calendar = {
    async render(parts) {
      const arg = parts[0] || '';
      const today = todayKey();
      const day = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : (/^\d{4}-\d{2}$/.test(arg) ? null : today);
      const month = (day || arg).slice(0, 7);
      return renderCalendar(month, day);
    },
  };

  const monthKeyOf = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;   // m: 0-11
  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return monthKeyOf(d.getFullYear(), d.getMonth());
  }
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');

  async function renderCalendar(month, day) {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const lead = (first.getDay() + 6) % 7;                    // Monday-first grid
    const start = new Date(y, m - 1, 1 - lead);
    const weeks = Math.ceil((lead + new Date(y, m, 0).getDate()) / 7);
    const today = todayKey();

    const from = Store.util.dateKey(start);
    const to = Store.util.dateKey(new Date(y, m - 1, 1 - lead + weeks * 7 - 1));
    const sessions = await Store.listSessions({ from, to });
    const bws = (await Store.listBodyweights()).filter((b) => b.date >= from && b.date <= to);
    const byDay = {};
    for (const s of sessions) (byDay[s.date] = byDay[s.date] || []).push(s);
    const bwDays = new Set(bws.map((b) => b.date));

    const inMonth = sessions.filter((s) => s.date.startsWith(month));
    const monthSets = inMonth.reduce((n, s) => n + mainSets(s).length, 0);
    const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const dowNames = [1, 2, 3, 4, 5, 6, 0].map((d) => new Date(2024, 0, d === 0 ? 7 : d).toLocaleDateString(undefined, { weekday: 'narrow' }));

    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(y, m - 1, 1 - lead + i);
      const key = Store.util.dateKey(d);
      const list = byDay[key] || [];
      const out = d.getMonth() !== m - 1;
      const marks = list.slice(0, 3).map((s) => `<span class="mark${s.finishedAt ? '' : ' open'}"></span>`).join('')
        + (!list.length && bwDays.has(key) ? '<span class="mark bw"></span>' : '');
      const label = `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${list.length ? `, ${plural(list.length, 'workout')}` : ''}`;
      cells += `<button class="day${out ? ' out' : ''}${list.length ? ' trained' : ''}${key === today ? ' today' : ''}"
        data-action="cal-day" data-day="${key}" aria-pressed="${key === day}" aria-label="${esc(label)}">
        <span class="d">${d.getDate()}</span><span class="marks">${marks}</span></button>`;
    }

    const nav = `<div class="cal-nav">
        <button class="icon-btn" data-action="cal-month" data-month="${shiftMonth(month, -1)}" aria-label="Previous month">${ICON.back}</button>
        <button class="icon-btn" data-action="cal-month" data-month="${shiftMonth(month, 1)}" aria-label="Next month"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button>
      </div>`;

    return `<header class="screen-head"><h1>Calendar</h1>${nav}</header>
      <div class="cal-month">
        <h2>${esc(monthName)}</h2>
        <span class="num">${inMonth.length ? `${plural(inMonth.length, 'workout')} · ${plural(monthSets, 'set')}` : 'No workouts'}</span>
      </div>
      <div class="cal" role="grid">
        ${dowNames.map((n) => `<span class="dow" aria-hidden="true">${esc(n)}</span>`).join('')}
        ${cells}
      </div>
      <div class="cal-legend">
        <span><i class="mark"></i>Workout</span>
        <span><i class="mark open"></i>In progress</span>
        <span><i class="mark bw"></i>Weigh-in only</span>
        ${month !== today.slice(0, 7) ? '<button class="text-btn" data-action="cal-today" style="min-height:24px;padding:0">Back to today</button>' : ''}
      </div>
      ${day ? await renderDay(day) : ''}
      <div style="height:24px"></div>`;
  }

  async function renderDay(day) {
    const sessions = await Store.listSessions({ from: day, to: day });
    const bws = (await Store.listBodyweights()).filter((b) => b.date === day);
    const ms = await Store.listMilestones();
    const prBySet = {};
    for (const mm of ms) (prBySet[mm.setId] = prBySet[mm.setId] || []).push(mm.type);

    const card = (s) => {
      const exIds = s.exerciseOrder.filter((x) => mainSets(s, x).length);
      const prCount = ms.filter((mm) => mm.sessionId === s.id).length;
      const time = s.finishedAt ? `${timeOf(s.startedAt)}–${timeOf(s.finishedAt)}` : `Started ${timeOf(s.startedAt)}`;
      return `<article class="sess-card">
        <div class="sc-head">
          <span class="t"><b>${esc(sessionLabel(s))}</b>${s.finishedAt ? '' : '<span class="live">In progress</span>'}
            <small class="num">${esc(time)} · ${plural(mainSets(s).length, 'set')}${prCount ? ` · ${plural(prCount, 'PR')}` : ''}</small></span>
          <button class="row-menu" data-action="${s.finishedAt ? 'sess-menu' : 'sess-open'}" data-id="${esc(s.id)}" aria-label="Workout options">⋯</button>
        </div>
        ${exIds.length ? exIds.map((x) => `<div class="sc-ex">
          <h3>${esc(exerciseName(x))}</h3>
          ${mainSets(s, x).map((set, i) => `
            <div class="set-row"><span class="n">${i + 1}</span><span class="w">${weightHtml(set.weightKg)}</span><span class="x">×</span>
              <span class="r">${set.reps}</span><span class="rpe">${set.rpe != null ? `RPE ${set.rpe}` : ''}</span>
              <span>${prBySet[set.id] ? `<span class="pr-badge">${TROPHY}PR</span>` : ''}</span></div>
            ${set.note ? `<div class="set-note">${esc(set.note)}</div>` : ''}
            ${dropsOf(s, set.id).map((d) => `<div class="drop-row"><span class="arrow">↳</span><span class="w">${weightHtml(d.weightKg)}</span>
              <span class="x">×</span><span class="r">${d.reps}</span><span class="tag-d">drop</span><span></span></div>`).join('')}`).join('')}
        </div>`).join('') : '<p class="empty">No sets logged yet.</p>'}
      </article>`;
    };

    return `<div class="day-head"><h2>${esc(prettyDate(day, true))}</h2></div>
      ${sessions.length ? sessions.map(card).join('') : `<p class="empty">${day > todayKey() ? 'Nothing here yet.' : 'Rest day.'}</p>`}
      <section class="group" style="margin-top:16px">
        <h2 class="group-title">Bodyweight</h2>
        ${bws.length ? `<div class="list bw-list">${bws.map((b) => `<div class="row">
            <span class="row-label">${b.sessionId ? 'After workout' : 'Weigh-in'}</span>
            <span class="num-r">${esc(weightPlain(b.kg))}</span>
            <button class="icon-btn" data-action="bw-delete" data-id="${esc(b.id)}" aria-label="Delete weigh-in">${ICON.x}</button>
          </div>`).join('')}</div>` : ''}
        ${day <= todayKey() ? `<div class="actions-bar" style="padding-top:${bws.length ? 12 : 0}px">
          <button class="btn btn-secondary btn-block" data-action="bw-log" data-day="${day}">Log bodyweight</button></div>` : ''}
      </section>`;
  }

  actions['cal-day'] = (el) => go(`#calendar/${el.dataset.day}`);
  actions['cal-month'] = (el) => go(`#calendar/${el.dataset.month}`);
  actions['cal-today'] = () => go('#calendar');
  actions['sess-open'] = () => go('#log');

  actions['sess-menu'] = async (el) => {
    const s = await Store.getSession(el.dataset.id);
    if (!s) return;
    const choice = await choiceSheet({
      title: `${sessionLabel(s)} · ${prettyDate(s.date)}`,
      options: [['edit', 'Edit this workout'], ['delete', 'Delete workout', true]],
    });
    if (choice === 'edit') {
      if (await Store.getActiveSession()) throw new Error('Finish your current workout first, then edit this one.');
      await Store.reopenSession(s.id);
      Object.assign(state, { entry: null, dropDraft: null });
      go('#log');
      toast(`Editing ${sessionLabel(s)}. Tap Finish when you are done.`);
    }
    if (choice === 'delete') {
      const ok = await confirmSheet({
        title: 'Delete this workout?',
        body: `All ${plural(mainSets(s).length, 'set')} and any PRs from ${prettyDate(s.date, true)} will be deleted. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await Store.deleteSession(s.id);
      await recomputeMilestones(s.sets.map((x) => x.exerciseId));
      await render({ keepScroll: true });
      toast('Workout deleted');
    }
  };

  actions['bw-log'] = async (el) => {
    const day = el.dataset.day;
    const bws = await Store.listBodyweights();
    const latest = bws[bws.length - 1];
    const saved = await formSheet({
      title: `Bodyweight · ${prettyDate(day)}`,
      submitLabel: 'Save',
      fields: [{ name: 'kg', label: `Weight (${Units.unit})`, value: '', placeholder: latest ? inputText(latest.kg) : '', inputmode: 'decimal', num: true }],
      onSubmit: (v) => {
        const w = Units.parse(v.kg);
        if (w.error || w.kg == null || w.kg <= 0) throw new Error('Enter your bodyweight as a number.');
        return Store.logBodyweight({ date: day, kg: w.kg });
      },
    });
    if (!saved) return;
    await render({ keepScroll: true });
    toast('Bodyweight saved');
  };

  actions['bw-delete'] = async (el) => {
    const ok = await confirmSheet({ title: 'Delete this weigh-in?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await Store.deleteBodyweight(el.dataset.id);
    await render({ keepScroll: true });
  };
  /* ================================================================== */
  /* PRs tab                                                             */
  /*   All     scatter of every milestone (date × weight; filled = weight */
  /*           PR, hollow = rep PR) and a dated list                     */
  /*   Weight  pick an exercise: max weight per session + weight PRs     */
  /*   Reps    pick an exercise, then a weight: reps over time + rep PRs */
  /* ================================================================== */

  state.prs = { view: 'all', exerciseId: null, weight: null, showAll: false };
  state.chartPoints = [];

  screens.prs = { render: renderPrs };

  const dayNum = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const weightKey = (kg) => (kg == null ? 'bw' : String(Math.round(kg * 1000) / 1000));
  const kgOfKey = (k) => (k === 'bw' ? null : Number(k));
  const typedKg = (kg) => (kg == null ? 0 : kg);
  const ICON_DOT = (hollow) => `<svg class="ms-icon${hollow ? ' hollow' : ''}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="${hollow ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="2"/></svg>`;

  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const r = raw / mag;
    const step = (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  function dateTicks(x0, x1) {
    const span = x1 - x0;
    const out = [];
    if (span <= 62) {
      const step = span <= 21 ? 7 : 14;
      for (let x = x0; x <= x1; x += step) out.push(x);
      return out.map((x) => [x, new Date(x * 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })]);
    }
    const d = new Date(x0 * 864e5);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth() + 1;
    const months = [];
    for (;;) {
      if (m > 11) { m = 0; y++; }
      const x = Date.UTC(y, m, 1) / 864e5;
      if (x > x1) break;
      months.push([x, y, m]);
      m++;
    }
    const every = Math.max(1, Math.ceil(months.length / 5));
    return months.filter((_, i) => i % every === 0).map(([x, yy, mm]) => [x,
      new Date(Date.UTC(yy, mm, 1)).toLocaleDateString(undefined, { month: 'short', ...(mm === 0 ? { year: '2-digit' } : {}), timeZone: 'UTC' })]);
  }

  /**
   * Inline SVG chart sized to the screen width.
   * points: [{ x: dayNum, y, hollow, detail }]  (detail = HTML shown on tap)
   * opts: { line, yFormat, yInteger }
   */
  function chartSvg(points, { line = false, yFormat = (v) => String(v), yInteger = false } = {}) {
    const W = Math.max(280, Math.min(window.innerWidth, 560) - 42);
    const H = 210;
    const m = { l: 42, r: 12, t: 12, b: 26 };
    const xs = points.map((p) => p.x);
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    if (x1 - x0 < 6) { x0 -= 3; x1 += 3; }
    const pad = (x1 - x0) * 0.04;
    x0 -= pad; x1 += pad;
    const ysRaw = points.map((p) => p.y);
    let yTicks = niceTicks(Math.min(...ysRaw), Math.max(...ysRaw));
    if (yInteger) yTicks = [...new Set(yTicks.map(Math.round))];
    const y0 = yTicks[0];
    const y1 = yTicks[yTicks.length - 1];
    const sx = (x) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (y) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const f = (n) => n.toFixed(1);

    state.chartPoints = points.map((p) => p.detail);
    const grid = yTicks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${f(sy(t))}" y2="${f(sy(t))}"/>
      <text class="tick-label" x="${m.l - 6}" y="${f(sy(t))}" text-anchor="end" dominant-baseline="central">${esc(String(yFormat(t)).replace(/^-/, '−'))}</text>`).join('');
    const xt = dateTicks(Math.ceil(x0), Math.floor(x1)).map(([x, label]) =>
      `<text class="tick-label" x="${f(sx(x))}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`).join('');
    const path = line && points.length > 1
      ? `<path class="ln draw" pathLength="1" d="${points.map((p, i) => `${i ? 'L' : 'M'}${f(sx(p.x))} ${f(sy(p.y))}`).join(' ')}"/>` : '';
    const dots = points.map((p, i) => `<circle class="pt${p.hollow ? ' hollow' : ''}" data-pt="${i}" cx="${f(sx(p.x))}" cy="${f(sy(p.y))}" r="${p.hollow ? 4.5 : 5}"/>`).join('');
    const hits = points.map((p, i) => `<circle class="hit" tabindex="0" role="button" aria-label="Point ${i + 1} of ${points.length}" data-action="chart-point" data-i="${i}" cx="${f(sx(p.x))}" cy="${f(sy(p.y))}" r="13"/>`).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
      ${grid}<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>${xt}${path}${dots}${hits}</svg>`;
  }

  actions['chart-point'] = (el) => {
    const i = Number(el.dataset.i);
    $$('.chart .pt.sel').forEach((p) => p.classList.remove('sel'));
    const dot = $(`.chart .pt[data-pt="${i}"]`);
    if (dot) { dot.classList.add('sel'); dot.parentNode.insertBefore(dot, $('.chart .hit')); }
    const box = $('#chart-detail');
    if (box) box.innerHTML = state.chartPoints[i] || '';
  };
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('.chart .hit')) {
      ev.preventDefault();
      actions['chart-point'](ev.target);
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.route.tab === 'prs') render({ keepScroll: true }); }, 200);
  });

  const msLabel = (m) => (m.type === 'weight' ? 'Weight PR' : 'Rep PR');
  const msDetail = (m) => `${TROPHY.replace('<svg', '<svg style="width:18px;height:18px;flex:none;color:var(--accent-text)"')}
    <span><b>${esc(exerciseName(m.exerciseId))}</b> · <span class="num">${esc(weightPlain(m.weightKg))} × ${m.reps}</span><br>
    <span class="muted">${msLabel(m)} · ${esc(prettyDate(m.date))} · ${m.type === 'weight'
      ? `was ${esc(weightPlain(m.previous.weightKg))}`
      : `was ${plural(m.previous.reps, 'rep')}`}</span></span>`;

  function msRow(m) {
    return `<div class="row">${ICON_DOT(m.type === 'reps')}
      <span class="row-label">${esc(exerciseName(m.exerciseId))}<small>${msLabel(m)} · ${esc(prettyDate(m.date))}</small></span>
      <span class="num-r">${esc(weightPlain(m.weightKg))} × ${m.reps}
        <small>${m.type === 'weight' ? `was ${esc(weightPlain(m.previous.weightKg))}` : `was ${plural(m.previous.reps, 'rep')}`}</small></span>
    </div>`;
  }


  /** Bodyweight over time: the latest weigh-in, change over 30 days, a line chart and the list. */
  async function renderBodyweightView() {
    const all = await Store.listBodyweights();
    const logBtn = `<div class="actions-bar"><button class="btn btn-secondary btn-block" data-action="bw-log" data-day="${todayKey()}">Log today's bodyweight</button></div>`;
    if (!all.length) {
      return `<div class="placeholder"><strong>No weigh-ins yet.</strong>
        <span>Log your bodyweight here, on any day in the Calendar, or at the end of a workout.</span></div>${logBtn}`;
    }
    // One point per day: the last weigh-in of that day.
    const byDay = new Map();
    for (const b of all) byDay.set(b.date, b);
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const latest = days[days.length - 1];
    const monthAgo = Store.util.dateKey(new Date(Date.now() - 30 * 864e5));
    const base = days.filter((d) => d.date <= monthAgo).pop() || days[0];
    const diff = Units.display(latest.kg) - Units.display(base.kg);
    const diffText = base === latest ? 'First weigh-in'
      : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(Math.round(diff * 10) / 10)} ${Units.unit} since ${prettyDate(base.date)}`;
    const points = days.map((d) => ({
      x: dayNum(d.date),
      y: Units.display(d.kg),
      hollow: false,
      detail: `<span><b class="num">${esc(weightPlain(d.kg))}</b> · ${esc(prettyDate(d.date))}<br>
        <span class="muted">${d.sessionId ? 'After a workout' : 'Weigh-in'}</span></span>`,
    }));
    const list = all.slice().reverse().slice(0, state.prs.showAll ? undefined : 20);
    return `<div class="pr-headline"><span class="big num">${esc(Units.format(latest.kg))}<small> ${Units.unit}</small></span>
        <span class="sub">${esc(prettyDate(latest.date))} · ${esc(diffText)}</span></div>
      ${days.length > 1 ? `<div class="chart-box has-detail">
        <div class="chart-key"><span><i></i>Bodyweight (${Units.unit})</span></div>
        ${chartSvg(points, { line: true })}
      </div>
      <div class="chart-detail" id="chart-detail"><span class="muted">Tap a dot to see the weigh-in.</span></div>` : ''}
      ${logBtn}
      <section class="group ms-list" style="margin-top:4px"><h2 class="group-title">Weigh-ins, newest first</h2>
        <div class="list">${list.map((b) => `<div class="row">
          <span class="row-label">${esc(prettyDate(b.date))}<small>${b.sessionId ? 'After a workout' : 'Weigh-in'}</small></span>
          <span class="num-r">${esc(weightPlain(b.kg))}</span></div>`).join('')}</div>
        ${all.length > list.length ? '<div class="actions-bar"><button class="btn btn-secondary btn-block" data-action="ms-more">Show all</button></div>' : ''}
      </section>`;
  }

  async function renderPrs() {
    const p = state.prs;
    const milestones = await Store.listMilestones();
    const sessions = await Store.listSessions();
    const trained = state.exercises.filter((e) => sessions.some((s) => mainSets(s, e.id).length))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!p.exerciseId || !trained.some((e) => e.id === p.exerciseId)) {
      const lastMs = milestones[milestones.length - 1];
      p.exerciseId = lastMs ? lastMs.exerciseId : (trained[0] || {}).id || null;
      p.weight = null;
    }

    const viewSelect = `<div class="field"><label for="pr-view">Show</label>
      <span class="select-wrap"><select class="select" id="pr-view" data-change="pr-view">
        ${[['all', 'All milestones'], ['weight', 'Weight PRs'], ['reps', 'Rep PRs'], ['bodyweight', 'Bodyweight']].map(([v, l]) =>
          `<option value="${v}"${p.view === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></span></div>`;
    const exSelect = `<div class="field"><label for="pr-ex">Exercise</label>
      <span class="select-wrap"><select class="select" id="pr-ex" data-change="pr-ex">
        ${trained.map((e) => `<option value="${esc(e.id)}"${e.id === p.exerciseId ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}
      </select></span></div>`;

    if (p.view === 'bodyweight') {
      return `${head('PRs')}<div class="pr-controls">${viewSelect}</div>${await renderBodyweightView()}<div style="height:24px"></div>`;
    }
    if (!trained.length) {
      return `${head('PRs')}<div class="pr-controls">${viewSelect}</div><div class="placeholder"><strong>No workouts yet.</strong>
        <span>Every exercise needs two sessions as a starting point. From the third session on, heavier sets and more reps at the same weight become milestones here.</span></div>`;
    }

    // Controls first: the weight picker settles the default weight the Reps chart uses.
    const controls = p.view === 'reps'
      ? `${viewSelect}<div class="two">${exSelect}${repWeightSelect(sessions)}</div>`
      : p.view === 'weight' ? `${viewSelect}${exSelect}` : viewSelect;

    let body = '';
    if (p.view === 'all') body = renderAllMilestones(milestones);
    else if (p.view === 'weight') body = renderWeightView(sessions, milestones);
    else body = renderRepsView(sessions, milestones);

    return `${head('PRs')}<div class="pr-controls">${controls}</div>${body}<div style="height:24px"></div>`;
  }

  function renderAllMilestones(milestones) {
    if (!milestones.length) {
      return `<div class="placeholder"><strong>No milestones yet.</strong>
        <span>Each exercise needs two sessions as a starting point. From the third session on, a heavier set or more reps at the same weight is a milestone.</span></div>`;
    }
    const nW = milestones.filter((m) => m.type === 'weight').length;
    const points = milestones.map((m) => ({
      x: dayNum(m.date),
      y: Units.display(typedKg(m.weightKg)),
      hollow: m.type === 'reps',
      detail: msDetail(m),
    }));
    const list = milestones.slice().reverse();
    const shown = state.prs.showAll ? list : list.slice(0, 20);
    return `<div class="pr-headline"><span class="big num">${milestones.length}<small> milestones</small></span>
        <span class="sub">${plural(nW, 'weight PR')} · ${plural(milestones.length - nW, 'rep PR')} across ${plural(new Set(milestones.map((m) => m.exerciseId)).size, 'exercise')}</span></div>
      <div class="chart-box has-detail">
        <div class="chart-key"><span><i></i>Weight PR</span><span><i class="hollow"></i>Rep PR</span><span>Up: weight (${Units.unit})</span></div>
        ${chartSvg(points, { yFormat: (v) => (v === 0 ? 'BW' : String(v)) })}
      </div>
      <div class="chart-detail" id="chart-detail"><span class="muted">Tap a dot to see the lift.</span></div>
      <section class="group ms-list"><h2 class="group-title">Newest first</h2>
        <div class="list">${shown.map(msRow).join('')}</div>
        ${list.length > shown.length ? `<div class="actions-bar"><button class="btn btn-secondary btn-block" data-action="ms-more">Show all ${list.length}</button></div>` : ''}
      </section>`;
  }

  function renderWeightView(sessions, milestones) {
    const exId = state.prs.exerciseId;
    const series = PRs.maxWeightSeries(sessions, exId);
    const prSessions = new Set(milestones.filter((m) => m.exerciseId === exId && m.type === 'weight').map((m) => m.sessionId));
    const ms = milestones.filter((m) => m.exerciseId === exId && m.type === 'weight').reverse();
    let best = series[0];
    for (const s of series) if (typedKg(s.weightKg) > typedKg(best.weightKg) + PRs.TOLERANCE_KG) best = s;
    const hasBw = series.some((s) => s.weightKg == null);
    const points = series.map((s) => ({
      x: dayNum(s.date),
      y: Units.display(typedKg(s.weightKg)),
      hollow: !prSessions.has(s.sessionId),
      detail: `<span><b class="num">${esc(weightPlain(s.weightKg))} × ${s.reps}</b> · ${esc(prettyDate(s.date))}<br>
        <span class="muted">${prSessions.has(s.sessionId) ? 'Weight PR this session' : 'Heaviest set this session'}</span></span>`,
    }));
    return `<div class="pr-headline"><span class="big num">${esc(Units.format(best.weightKg))}<small> ${best.weightKg == null ? '' : Units.unit} × ${best.reps}</small></span>
        <span class="sub">Heaviest so far · ${esc(prettyDate(best.date))} · ${plural(series.length, 'session')}</span></div>
      <div class="chart-box has-detail">
        <div class="chart-key"><span><i></i>Weight PR</span><span><i class="hollow"></i>Heaviest set of a session</span></div>
        ${chartSvg(points, { line: true, yFormat: (v) => (v === 0 && hasBw ? 'BW' : String(v)) })}
      </div>
      <div class="chart-detail" id="chart-detail"><span class="muted">Tap a dot to see the session.</span></div>
      <section class="group ms-list"><h2 class="group-title">Weight PRs, newest first</h2>
        ${ms.length ? `<div class="list">${ms.map(msRow).join('')}</div>`
          : `<p class="empty">${series.length < 3 ? `PRs count from the 3rd session. ${plural(series.length, 'session')} logged so far.` : 'No weight PRs yet.'}</p>`}
      </section>`;
  }

  function repWeights(sessions) {
    return PRs.weightsUsed(sessions, state.prs.exerciseId);
  }

  function repWeightSelect(sessions) {
    const list = repWeights(sessions);
    if (!list.some((w) => weightKey(w.weightKg) === state.prs.weight)) {
      // Default: the weight used most often.
      const top = list.slice().sort((a, b) => b.sets - a.sets)[0];
      state.prs.weight = top ? weightKey(top.weightKg) : null;
    }
    return `<div class="field"><label for="pr-w">Weight</label>
      <span class="select-wrap"><select class="select num" id="pr-w" data-change="pr-w">
        ${list.map((w) => `<option value="${weightKey(w.weightKg)}"${weightKey(w.weightKg) === state.prs.weight ? ' selected' : ''}>${esc(weightPlain(w.weightKg))} · ${plural(w.sets, 'set')}</option>`).join('')}
      </select></span></div>`;
  }

  function renderRepsView(sessions, milestones) {
    const exId = state.prs.exerciseId;
    const kg = kgOfKey(state.prs.weight);
    const series = PRs.repsAtWeightSeries(sessions, exId, kg);
    const near = (a) => Math.abs(typedKg(a) - typedKg(kg)) <= PRs.TOLERANCE_KG;
    const ms = milestones.filter((m) => m.exerciseId === exId && m.type === 'reps' && near(m.weightKg)).reverse();
    const prSessions = new Set(ms.map((m) => m.sessionId));
    if (!series.length) return '<p class="empty">No sets at this weight yet.</p>';
    let best = series[0];
    for (const s of series) if (s.reps > best.reps) best = s;
    const points = series.map((s) => ({
      x: dayNum(s.date),
      y: s.reps,
      hollow: !prSessions.has(s.sessionId),
      detail: `<span><b class="num">${plural(s.reps, 'rep')}</b> at ${esc(weightPlain(kg))} · ${esc(prettyDate(s.date))}<br>
        <span class="muted">${prSessions.has(s.sessionId) ? 'Rep PR this session' : 'Most reps this session'}</span></span>`,
    }));
    return `<div class="pr-headline"><span class="big num">${best.reps}<small> reps at ${esc(weightPlain(kg))}</small></span>
        <span class="sub">Most so far · ${esc(prettyDate(best.date))} · ${plural(series.length, 'session')} at this weight</span></div>
      <div class="chart-box has-detail">
        <div class="chart-key"><span><i></i>Rep PR</span><span><i class="hollow"></i>Most reps in a session</span></div>
        ${chartSvg(points, { line: true, yInteger: true })}
      </div>
      <div class="chart-detail" id="chart-detail"><span class="muted">Tap a dot to see the session.</span></div>
      <section class="group ms-list"><h2 class="group-title">Rep PRs at ${esc(weightPlain(kg))}, newest first</h2>
        ${ms.length ? `<div class="list">${ms.map(msRow).join('')}</div>` : '<p class="empty">No rep PRs at this weight yet.</p>'}
      </section>`;
  }

  changes['pr-view'] = (el) => { state.prs.view = el.value; state.prs.showAll = false; return render({ keepScroll: true }); };
  changes['pr-ex'] = (el) => { state.prs.exerciseId = el.value; state.prs.weight = null; return render({ keepScroll: true }); };
  changes['pr-w'] = (el) => { state.prs.weight = el.value; return render({ keepScroll: true }); };
  actions['ms-more'] = () => { state.prs.showAll = true; return render({ keepScroll: true }); };

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
        <div class="row wrap"><span class="row-label">Colour<small>${esc((ACCENT_OPTIONS.find((o) => o[0] === (s.accent || 'green')) || ACCENT_OPTIONS[0])[1])}</small></span>
          <div class="swatches" role="group" aria-label="Colour">
            ${ACCENT_OPTIONS.map(([id, name, light, dark, inkL, inkD]) => {
              const d = isDark(s.theme);
              return `<button class="swatch" data-action="set-accent" data-value="${id}" aria-pressed="${(s.accent || 'green') === id}"
                aria-label="${name}" title="${name}" style="background:${d ? dark : light};--sw-ink:${d ? inkD : inkL}"></button>`;
            }).join('')}
          </div></div>
      </div>
    </section>

    <section class="group">
      <h2 class="group-title">Workout screen</h2>
      <div class="list">
        <div class="row"><span class="row-label">RPE slider<small>Starts empty for each set. Slide it to rate 6 to 10.</small></span>
          ${sw('toggle-rpe', s.rpeEnabled, 'RPE slider')}</div>
        <div class="row wrap"><span class="row-label">Timer<small>Rest countdown and stopwatch</small></span>
          ${seg('set-rest-place', rt.enabled ? rt.placement : 'off', [['off', 'Off'], ['panel', 'In log'], ['corner', 'Corner']])}</div>
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

    <section class="group">
      <div class="list">
        <div class="row"><span class="row-label">Hercules<small>Version ${APP_VERSION}</small></span></div>
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
  actions['set-theme'] = (el) => {
    const next = el.dataset.value;
    const change = () => saveSettings({ theme: next });
    if (isDark(next) === isDark(state.settings.theme)) return change();   // looks the same: no animation
    const b = el.getBoundingClientRect();
    return withThemeTransition(change, { x: b.left + b.width / 2, y: b.top + b.height / 2 });
  };
  actions['set-accent'] = (el) => {
    const next = el.dataset.value;
    if (next === (state.settings.accent || 'green')) return null;
    const b = el.getBoundingClientRect();
    return withThemeTransition(() => saveSettings({ accent: next }), { x: b.left + b.width / 2, y: b.top + b.height / 2 });
  };
  actions['toggle-rpe'] = () => saveSettings({ rpeEnabled: !state.settings.rpeEnabled });
  actions['set-rest-place'] = (el) => {
    const v = el.dataset.value;
    if (v === 'off') timerStop();
    return saveSettings({ restTimer: v === 'off' ? { enabled: false } : { enabled: true, placement: v } });
  };
  actions['set-rest-start'] = (el) => saveSettings({ restTimer: { autoStart: el.dataset.value === 'auto' } });
  actions['rest-step'] = (el) => {
    const next = Math.min(600, Math.max(15, state.settings.restTimer.durationSec + Number(el.dataset.step)));
    return saveSettings({ restTimer: { durationSec: next } });
  };
  actions['toggle-schedule'] = () => saveSettings({ schedule: { enabled: !state.settings.schedule.enabled } });
  changes['set-day'] = (el) => saveSettings({ schedule: { days: { [el.dataset.day]: el.value || null } } });

  /* ---------- Export / import ---------- */

  actions.export = async () => {
    const data = await Store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hercules-${Store.util.dateKey()}.json`;
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
    const problems = await Store.checkImport(data);
    if (problems.length) throw new Error(`This file can't be imported:\n${problems.join('\n')}`);
    const n = data.sessions.length;
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

    // Offline support (needs http(s), not file://).
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable:', err));
    }
    // Ask the browser not to clear this site's storage when the phone runs low on space.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  // For debugging in the console only.
  window.WT = { state, Units, render, refresh };

  boot();
})();
