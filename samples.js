/*
 * samples.js
 *
 * Builds about nine weeks of realistic Push / Pull / Legs history for trying
 * the app (Settings → hidden "Load sample data") and for tests. The result has
 * the same shape as an export file, so it loads through Store.importData().
 * It needs prs.js loaded first so the sample milestones are filled in.
 *
 * It is deterministic: the same `today` always gives the same data.
 * It covers drop sets, bodyweight and assisted sets, weighted dips, RPE,
 * notes, a missed week, two sessions on one day and weekly weigh-ins.
 */
(function (global) {
  'use strict';

  function rng(seed) {                       // mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  // [exerciseId, targetSets, start kg (null = bodyweight), step kg, rep range, dropChance]
  const PLAN = {
    push: { name: 'Push', items: [
      ['ex_bench-press', 3, 72.5, 2.5, [5, 8], 0.2],
      ['ex_overhead-press', 3, 40, 2.5, [5, 8], 0],
      ['ex_incline-dumbbell-press', 3, 24, 2, [8, 12], 0],
      ['ex_dips', 3, null, 5, [6, 10], 0],
      ['ex_lateral-raise', 3, 8, 1, [12, 15], 0.6],
      ['ex_triceps-pushdown', 3, 25, 2.5, [10, 12], 0.5],
    ]},
    pull: { name: 'Pull', items: [
      ['ex_deadlift', 2, 120, 5, [3, 5], 0],
      ['ex_pull-up', 3, -30, 5, [6, 10], 0],
      ['ex_barbell-row', 3, 60, 2.5, [6, 10], 0],
      ['ex_face-pull', 3, 20, 2.5, [12, 15], 0],
      ['ex_barbell-curl', 3, 30, 2.5, [8, 12], 0.5],
    ]},
    legs: { name: 'Legs', items: [
      ['ex_back-squat', 3, 90, 2.5, [5, 8], 0],
      ['ex_romanian-deadlift', 3, 80, 2.5, [8, 10], 0],
      ['ex_leg-press', 3, 160, 10, [10, 12], 0.4],
      ['ex_leg-curl', 3, 40, 2.5, [10, 12], 0.4],
      ['ex_standing-calf-raise', 3, 60, 5, [10, 15], 0],
    ]},
  };
  const ROTATION = ['push', 'pull', 'legs'];
  const TRAINING_DAYS = [1, 3, 5, 6];        // Mon, Wed, Fri, Sat
  const NOTES = ['Felt strong', 'Paused reps', 'Left shoulder a bit tight', 'Belt on', 'Slow eccentric'];

  /**
   * base: the current export (await Store.exportData()); its settings and
   * exercises are kept. today: sessions run up to the day before.
   * Load the result with Store.importData(); it replaces existing history.
   */
  function build({ base, today = new Date(), weeks = 9, seed = 7 } = {}) {
    if (!base || !Array.isArray(base.exercises)) throw new Error('SampleData.build needs the current export as `base`.');
    const rand = rng(seed);
    const pick = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const ids = { n: 0 };
    const id = (p) => `${p}_sample${(++ids.n).toString(36).padStart(4, '0')}`;

    const sessionTypes = Object.entries(PLAN).map(([k, p]) => ({
      id: `st_sample_${k}`,
      name: p.name,
      items: p.items.map(([exerciseId, targetSets]) => ({ exerciseId, targetSets })),
    }));

    // Working weight per exercise, nudged up over time.
    const working = {};
    for (const p of Object.values(PLAN)) for (const it of p.items) working[it[0]] = it[2];
    const seen = {};

    const end = addDays(new Date(today.getFullYear(), today.getMonth(), today.getDate()), -1);
    const start = addDays(end, -weeks * 7 + 1);
    const skipWeek = Math.floor(weeks / 2);   // one missed week in the middle
    const sessions = [];
    const bodyweights = [];
    let rot = 0;
    let bw = 81.5;

    for (let day = new Date(start), i = 0; day <= end; day = addDays(day, 1), i++) {
      const week = Math.floor(i / 7);
      if (week === skipWeek) continue;
      if (day.getDay() === 1) {               // Monday weigh-in
        bw = Math.round((bw + (rand() - 0.55) * 0.6) * 10) / 10;
        bodyweights.push({ id: id('bw'), date: keyOf(day), kg: bw, sessionId: null, loggedAt: `${keyOf(day)}T07:00:00.000Z` });
      }
      if (!TRAINING_DAYS.includes(day.getDay())) continue;

      const kind = ROTATION[rot++ % ROTATION.length];
      sessions.push(makeSession(day, kind, 18));
      // Two sessions on one day once: a short arms top-up in the evening.
      if (week === 2 && day.getDay() === 6) sessions.push(makeArms(day));
    }

    function makeSession(day, kind, hour) {
      const p = PLAN[kind];
      const startedAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, pick(0, 30));
      let clock = startedAt.getTime();
      const s = {
        id: id('s'), date: keyOf(day), startedAt: startedAt.toISOString(), finishedAt: null,
        sessionTypeId: `st_sample_${kind}`, exerciseOrder: [], currentExerciseId: null, sets: [],
      };
      for (const [exId, target, , step, [lo, hi], dropChance] of p.items) {
        s.exerciseOrder.push(exId);
        // Progress: usually hold, sometimes add a step, rarely back off.
        // Bodyweight lifts stay at bodyweight for a few sessions before adding weight;
        // assisted pull-ups become plain bodyweight when the assistance reaches 0.
        const r = rand();
        seen[exId] = (seen[exId] || 0) + 1;
        if (working[exId] == null) {
          if (seen[exId] > 4 && r < 0.3) working[exId] = step;
        } else if (r < 0.35) {
          working[exId] += step;
          if (working[exId] === 0) working[exId] = null;
        } else if (r > 0.95) {
          working[exId] -= step;
        }
        const nSets = target + (rand() < 0.15 ? 1 : 0);
        for (let k = 0; k < nSets; k++) {
          clock += pick(90, 180) * 1000;
          const reps = Math.max(1, pick(lo, hi) - Math.floor(k / 2));
          const main = {
            id: id('set'), kind: 'main', parentId: null, exerciseId: exId,
            weightKg: working[exId], reps,
            rpe: rand() < 0.7 ? Math.min(10, 7 + Math.floor(rand() * 6) / 2) : null,
            note: rand() < 0.05 ? NOTES[pick(0, NOTES.length - 1)] : '',
            loggedAt: new Date(clock).toISOString(),
          };
          s.sets.push(main);
          if (k === nSets - 1 && rand() < dropChance && main.weightKg) {
            let w = main.weightKg;
            const drops = rand() < 0.4 ? 2 : 1;
            for (let j = 0; j < drops; j++) {
              w = Math.round(w * 0.75 / 1.25) * 1.25;
              clock += 20 * 1000;
              s.sets.push({ id: id('set'), kind: 'drop', parentId: main.id, exerciseId: exId,
                weightKg: w, reps: pick(8, 12), rpe: null, note: '', loggedAt: new Date(clock).toISOString() });
            }
          }
        }
      }
      s.finishedAt = new Date(clock + 5 * 60 * 1000).toISOString();
      return s;
    }

    function makeArms(day) {
      const startedAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 20, 15);
      let clock = startedAt.getTime();
      const s = {
        id: id('s'), date: keyOf(day), startedAt: startedAt.toISOString(), finishedAt: null,
        sessionTypeId: null, exerciseOrder: ['ex_hammer-curl'], currentExerciseId: null, sets: [],
      };
      for (let k = 0; k < 3; k++) {
        clock += 120 * 1000;
        s.sets.push({ id: id('set'), kind: 'main', parentId: null, exerciseId: 'ex_hammer-curl',
          weightKg: 14, reps: 12 - k, rpe: null, note: '', loggedAt: new Date(clock).toISOString() });
      }
      s.finishedAt = new Date(clock + 60 * 1000).toISOString();
      return s;
    }

    // Session weigh-in on the last session, like the finish screen would save.
    const last = sessions[sessions.length - 1];
    if (last) bodyweights.push({ id: id('bw'), date: last.date, kg: bw, sessionId: last.id, loggedAt: last.finishedAt });

    const milestones = global.PRs
      ? global.PRs.computeAllMilestones(sessions).map((m) => ({ id: id('pr'), ...m }))
      : [];

    // Keep the user's own settings and exercises; replace the training history.
    return { ...base, sessionTypes, sessions, milestones, bodyweights };
  }

  const SampleData = { build };
  global.SampleData = SampleData;
  if (typeof module !== 'undefined' && module.exports) module.exports = SampleData;
})(typeof window !== 'undefined' ? window : globalThis);
