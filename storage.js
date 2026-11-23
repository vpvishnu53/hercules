/*
 * storage.js
 *
 * The only file that knows how data is persisted. Everything else in the app
 * talks to the `Store` object below, and every Store method returns a Promise,
 * so a sync backend (a server, IndexedDB, etc.) can replace localStorage later
 * without touching the rest of the app: write a new backend with the same
 * load()/save() shape and pass it to Store.init().
 *
 * Units: every weight is stored in kilograms at full precision. Conversion to
 * pounds happens only for display and input, outside this file.
 *
 * Data shape (schemaVersion 1):
 *   settings      units, theme, RPE, rest timer, weekly schedule
 *   exercises     preset + custom lifts; referenced everywhere by id, so a
 *                 rename keeps all history attached
 *   sessionTypes  the user's split (Push, Pull, ...), each with an ordered
 *                 list of { exerciseId, targetSets }. Empty until the user
 *                 creates one.
 *   sessions      one per workout. `date` is the local calendar day the session
 *                 was started on and does not change when it is resumed later.
 *                 Sets live inside their session.
 *   milestones    saved PRs (weight and rep records)
 *   bodyweights   weigh-ins, either from a finished session or logged on their own
 */
(function (global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'workoutTracker.v1';

  /* ------------------------------------------------------------------ */
  /* Backend: localStorage                                               */
  /* ------------------------------------------------------------------ */

  function createLocalBackend(key = STORAGE_KEY, storage = global.localStorage) {
    return {
      async load() {
        const raw = storage.getItem(key);
        if (raw == null) return null;
        try {
          return JSON.parse(raw);
        } catch (err) {
          // Never overwrite data we couldn't read. Keep a copy and stop.
          const backupKey = `${key}.unreadable.${Date.now()}`;
          try { storage.setItem(backupKey, raw); } catch (_) { /* storage full */ }
          throw new StoreError(
            `Saved data could not be read. A copy was kept under "${backupKey}".`,
            'unreadable'
          );
        }
      },
      async save(db) {
        try {
          storage.setItem(key, JSON.stringify(db));
        } catch (err) {
          throw new StoreError(
            'Could not save: browser storage is full. Export your data, then delete old sessions.',
            'quota'
          );
        }
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  class StoreError extends Error {
    constructor(message, code = 'invalid') {
      super(message);
      this.name = 'StoreError';
      this.code = code;
    }
  }

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function newId(prefix) {
    const rand = global.crypto && global.crypto.randomUUID
      ? global.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return `${prefix}_${rand}`;
  }

  /** Local calendar day as YYYY-MM-DD (not UTC, so late-night sessions land on the right day). */
  function dateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const nowIso = () => new Date().toISOString();
  const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function slug(s) {
    return cleanName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function assert(cond, message) {
    if (!cond) throw new StoreError(message);
  }

  function checkWeight(w) {
    assert(w === null || (typeof w === 'number' && Number.isFinite(w)),
      'Weight must be a number, or blank for bodyweight.');
  }
  function checkReps(r) {
    assert(Number.isInteger(r) && r >= 1 && r <= 1000, 'Reps must be a whole number of 1 or more.');
  }
  function checkRpe(r) {
    assert(r === null || (typeof r === 'number' && r >= 6 && r <= 10 && Math.round(r * 2) === r * 2),
      'RPE must be between 6 and 10 in steps of 0.5.');
  }

  /* ------------------------------------------------------------------ */
  /* Defaults                                                            */
  /* ------------------------------------------------------------------ */

  const ACCENTS = ['green', 'blue', 'red', 'orange', 'yellow', 'graphite'];
  const MUSCLE_GROUPS = ['chest', 'back', 'shoulders', 'legs', 'arms', 'core', 'other'];

  const PRESET_EXERCISES = [
    ['Bench Press', 'chest'], ['Incline Bench Press', 'chest'], ['Dumbbell Bench Press', 'chest'],
    ['Incline Dumbbell Press', 'chest'], ['Cable Chest Fly', 'chest'], ['Dips', 'chest'], ['Push-up', 'chest'],
    ['Overhead Press', 'shoulders'], ['Dumbbell Shoulder Press', 'shoulders'], ['Lateral Raise', 'shoulders'],
    ['Rear Delt Fly', 'shoulders'], ['Face Pull', 'shoulders'],
    ['Deadlift', 'back'], ['Pull-up', 'back'], ['Chin-up', 'back'], ['Lat Pulldown', 'back'],
    ['Barbell Row', 'back'], ['Dumbbell Row', 'back'], ['Seated Cable Row', 'back'], ['T-Bar Row', 'back'],
    ['Back Squat', 'legs'], ['Front Squat', 'legs'], ['Romanian Deadlift', 'legs'], ['Leg Press', 'legs'],
    ['Bulgarian Split Squat', 'legs'], ['Walking Lunge', 'legs'], ['Leg Extension', 'legs'],
    ['Leg Curl', 'legs'], ['Hip Thrust', 'legs'], ['Standing Calf Raise', 'legs'],
    ['Barbell Curl', 'arms'], ['Dumbbell Curl', 'arms'], ['Hammer Curl', 'arms'],
    ['Triceps Pushdown', 'arms'], ['Skull Crusher', 'arms'], ['Overhead Triceps Extension', 'arms'],
    ['Close-Grip Bench Press', 'arms'],
    ['Hanging Leg Raise', 'core'], ['Cable Crunch', 'core'], ['Ab Wheel Rollout', 'core'],
  ].map(([name, group]) => ({
    id: `ex_${slug(name)}`, name, group, custom: false, archived: false,
  }));

  function defaultSettings() {
    return {
      units: 'kg',            // 'kg' | 'lb'
      theme: 'system',        // 'system' | 'light' | 'dark'
      accent: 'green',        // colour option: green (default), blue, red, orange, yellow, graphite
      rpeEnabled: false,
      restTimer: { enabled: false, autoStart: false, durationSec: 120 },
      // days: keyed by JS weekday (0 = Sunday) -> sessionTypeId or null
      schedule: { enabled: false, days: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } },
    };
  }

  function emptyDb() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: defaultSettings(),
      exercises: PRESET_EXERCISES.map((e) => ({ ...e })),
      sessionTypes: [],
      sessions: [],
      milestones: [],
      bodyweights: [],
    };
  }

  /* ------------------------------------------------------------------ */
  /* Validation / migration                                              */
  /* ------------------------------------------------------------------ */

  /** Fills gaps in an older or partial db and adds any new preset exercises. */
  function normalise(db) {
    const base = emptyDb();
    const out = {
      schemaVersion: SCHEMA_VERSION,
      settings: { ...base.settings, ...(db.settings || {}) },
      exercises: Array.isArray(db.exercises) ? db.exercises : base.exercises,
      sessionTypes: Array.isArray(db.sessionTypes) ? db.sessionTypes : [],
      sessions: Array.isArray(db.sessions) ? db.sessions : [],
      milestones: Array.isArray(db.milestones) ? db.milestones : [],
      bodyweights: Array.isArray(db.bodyweights) ? db.bodyweights : [],
    };
    out.settings.restTimer = { ...base.settings.restTimer, ...(out.settings.restTimer || {}) };
    out.settings.schedule = {
      ...base.settings.schedule,
      ...(out.settings.schedule || {}),
      days: { ...base.settings.schedule.days, ...((out.settings.schedule || {}).days || {}) },
    };
    const known = new Set(out.exercises.map((e) => e.id));
    for (const p of PRESET_EXERCISES) if (!known.has(p.id)) out.exercises.push({ ...p });
    for (const s of out.sessions) {
      if (!Array.isArray(s.sets)) s.sets = [];
      if (!Array.isArray(s.exerciseOrder)) s.exerciseOrder = [];
    }
    return out;
  }

  /** Returns a list of human-readable problems; empty means the data looks usable. */
  function validate(db) {
    const problems = [];
    if (!db || typeof db !== 'object') return ['The file does not contain workout data.'];
    if (typeof db.schemaVersion === 'number' && db.schemaVersion > SCHEMA_VERSION) {
      problems.push('This file was made by a newer version of the app.');
    }
    for (const key of ['exercises', 'sessions']) {
      if (!Array.isArray(db[key])) problems.push(`Missing the "${key}" list.`);
    }
    if (problems.length) return problems;
    const exIds = new Set(db.exercises.map((e) => e && e.id));
    db.sessions.forEach((s, i) => {
      if (!s || typeof s.id !== 'string') { problems.push(`Session ${i + 1} has no id.`); return; }
      if (!isDateKey(s.date)) problems.push(`Session ${s.id} has an invalid date.`);
      (s.sets || []).forEach((set) => {
        if (!set || typeof set.id !== 'string') problems.push(`A set in session ${s.date} has no id.`);
        else if (!exIds.has(set.exerciseId)) problems.push(`A set on ${s.date} points to an unknown exercise.`);
      });
    });
    return problems.slice(0, 20);
  }

  /* ------------------------------------------------------------------ */
  /* Store                                                               */
  /* ------------------------------------------------------------------ */

  let backend = null;
  let db = null;
  let queue = Promise.resolve();

  function ready() {
    if (!db) throw new StoreError('Store.init() must finish before the store is used.', 'not-ready');
  }

  /**
   * Applies `mutate` to a copy of the data, saves it, and only then makes it
   * current, so a failed save leaves the in-memory data untouched. Writes run
   * one at a time in call order.
   */
  function write(mutate) {
    const run = async () => {
      ready();
      const draft = clone(db);
      const result = mutate(draft);
      await backend.save(draft);
      db = draft;
      return clone(result);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  const read = async (fn) => { ready(); return clone(fn(db)); };

  const findSession = (d, id) => {
    const s = d.sessions.find((x) => x.id === id);
    assert(s, 'That session no longer exists.');
    return s;
  };
  const findExercise = (d, id) => {
    const e = d.exercises.find((x) => x.id === id);
    assert(e, 'That exercise no longer exists.');
    return e;
  };
  const sessionSort = (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.startedAt || '').localeCompare(b.startedAt || '');

  /** The visible exercise already using this name (any case), or undefined. */
  function nameTaken(d, name, exceptId) {
    const n = name.toLowerCase();
    return d.exercises.find((e) => !e.archived && e.id !== exceptId && e.name.toLowerCase() === n);
  }

  const Store = {
    SCHEMA_VERSION,
    MUSCLE_GROUPS,
    ACCENTS,
    StoreError,
    util: { dateKey, newId },
    createLocalBackend,

    /** Loads data (or creates an empty store). Call once before anything else. */
    async init(customBackend) {
      backend = customBackend || createLocalBackend();
      const loaded = await backend.load();
      if (loaded) {
        db = normalise(loaded);
      } else {
        db = emptyDb();
        await backend.save(db);
      }
      queue = Promise.resolve();
      return true;
    },

    /* ---------- Settings ---------- */

    getSettings() { return read((d) => d.settings); },

    /** Shallow-merges `patch`; restTimer, schedule and schedule.days merge one level deeper. */
    updateSettings(patch) {
      return write((d) => {
        const s = d.settings;
        const { restTimer, schedule, ...rest } = patch || {};
        if (rest.units !== undefined) assert(['kg', 'lb'].includes(rest.units), 'Units must be kg or lb.');
        if (rest.theme !== undefined) assert(['system', 'light', 'dark'].includes(rest.theme), 'Unknown theme.');
        if (rest.accent !== undefined) assert(ACCENTS.includes(rest.accent), 'Unknown colour.');
        Object.assign(s, rest);
        if (restTimer) {
          Object.assign(s.restTimer, restTimer);
          const sec = s.restTimer.durationSec;
          assert(Number.isInteger(sec) && sec >= 5 && sec <= 3600, 'Rest time must be between 5 seconds and 60 minutes.');
        }
        if (schedule) {
          const { days, ...sched } = schedule;
          Object.assign(s.schedule, sched);
          if (days) {
            for (const [k, v] of Object.entries(days)) {
              assert(v === null || d.sessionTypes.some((t) => t.id === v), 'That session type no longer exists.');
              s.schedule.days[k] = v;
            }
          }
        }
        return s;
      });
    },

    /* ---------- Exercises ---------- */

    listExercises({ includeArchived = false } = {}) {
      return read((d) => d.exercises
        .filter((e) => includeArchived || !e.archived)
        .sort((a, b) => a.name.localeCompare(b.name)));
    },

    getExercise(id) { return read((d) => d.exercises.find((e) => e.id === id) || null); },

    addExercise({ name, group = 'other' }) {
      return write((d) => {
        const n = cleanName(name);
        assert(n, 'Give the exercise a name.');
        const clash = nameTaken(d, n);
        assert(!clash, `You already have an exercise called "${clash && clash.name}".`);
        assert(MUSCLE_GROUPS.includes(group), 'Unknown muscle group.');
        const ex = { id: newId('ex'), name: n, group, custom: true, archived: false };
        d.exercises.push(ex);
        return ex;
      });
    },

    /** Renames keep history: sets reference the id, not the name. */
    updateExercise(id, { name, group }) {
      return write((d) => {
        const ex = findExercise(d, id);
        if (name !== undefined) {
          const n = cleanName(name);
          assert(n, 'Give the exercise a name.');
          const clash = nameTaken(d, n, id);
          assert(!clash, `You already have an exercise called "${clash && clash.name}".`);
          ex.name = n;
        }
        if (group !== undefined) {
          assert(MUSCLE_GROUPS.includes(group), 'Unknown muscle group.');
          ex.group = group;
        }
        return ex;
      });
    },

    /** Hides an exercise from pickers. History and milestones are kept. */
    setExerciseArchived(id, archived) {
      return write((d) => {
        const ex = findExercise(d, id);
        if (!archived) assert(!nameTaken(d, ex.name, id), `You already have another exercise called "${ex.name}". Rename one first.`);
        ex.archived = !!archived;
        return ex;
      });
    },

    /* ---------- Split (session types) ---------- */

    listSessionTypes() { return read((d) => d.sessionTypes); },

    /** Creates (no id) or replaces (with id) a session type. items: [{ exerciseId, targetSets }] */
    saveSessionType({ id, name, items = [] }) {
      return write((d) => {
        const n = cleanName(name);
        assert(n, 'Give the session a name, like Push or Legs.');
        const clash = d.sessionTypes.find((t) => t.id !== id && t.name.toLowerCase() === n.toLowerCase());
        assert(!clash, `You already have a session called "${clash && clash.name}".`);
        const cleanItems = items.map((it) => {
          findExercise(d, it.exerciseId);
          const t = Number(it.targetSets);
          assert(Number.isInteger(t) && t >= 1 && t <= 20, 'Target sets must be between 1 and 20.');
          return { exerciseId: it.exerciseId, targetSets: t };
        });
        if (id) {
          const st = d.sessionTypes.find((t) => t.id === id);
          assert(st, 'That session type no longer exists.');
          st.name = n;
          st.items = cleanItems;
          return st;
        }
        const st = { id: newId('st'), name: n, items: cleanItems };
        d.sessionTypes.push(st);
        return st;
      });
    },

    /** Past sessions keep their data; they just show as Freestyle afterwards. */
    deleteSessionType(id) {
      return write((d) => {
        d.sessionTypes = d.sessionTypes.filter((t) => t.id !== id);
        for (const k of Object.keys(d.settings.schedule.days)) {
          if (d.settings.schedule.days[k] === id) d.settings.schedule.days[k] = null;
        }
        return true;
      });
    },

    reorderSessionTypes(ids) {
      return write((d) => {
        const byId = new Map(d.sessionTypes.map((t) => [t.id, t]));
        const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
        const rest = d.sessionTypes.filter((t) => !ids.includes(t.id));
        d.sessionTypes = [...ordered, ...rest];
        return d.sessionTypes;
      });
    },

    /* ---------- Sessions ---------- */

    /** Sorted oldest first. Optional inclusive date range as YYYY-MM-DD. */
    listSessions({ from, to } = {}) {
      return read((d) => d.sessions
        .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
        .sort(sessionSort));
    },

    getSession(id) { return read((d) => d.sessions.find((s) => s.id === id) || null); },

    /** The unfinished session, if any. Its date stays the day it was started. */
    getActiveSession() {
      return read((d) => d.sessions.filter((s) => !s.finishedAt).sort(sessionSort).pop() || null);
    },

    startSession({ sessionTypeId = null, date } = {}) {
      return write((d) => {
        assert(!d.sessions.some((s) => !s.finishedAt), 'Finish the current session before starting a new one.');
        if (sessionTypeId) assert(d.sessionTypes.some((t) => t.id === sessionTypeId), 'That session type no longer exists.');
        const st = d.sessionTypes.find((t) => t.id === sessionTypeId);
        const order = st ? st.items.map((i) => i.exerciseId) : [];
        const s = {
          id: newId('s'),
          date: date || dateKey(),
          startedAt: nowIso(),
          finishedAt: null,
          sessionTypeId: sessionTypeId || null,
          exerciseOrder: [],          // exercises actually opened this session, in order
          currentExerciseId: order[0] || null,
          sets: [],
        };
        if (s.currentExerciseId) s.exerciseOrder.push(s.currentExerciseId);
        assert(isDateKey(s.date), 'Invalid date.');
        d.sessions.push(s);
        return s;
      });
    },

    /** Editable fields: date, sessionTypeId, currentExerciseId, exerciseOrder. */
    updateSession(id, patch) {
      return write((d) => {
        const s = findSession(d, id);
        const p = patch || {};
        if (p.date !== undefined) { assert(isDateKey(p.date), 'Invalid date.'); s.date = p.date; }
        if (p.sessionTypeId !== undefined) {
          assert(p.sessionTypeId === null || d.sessionTypes.some((t) => t.id === p.sessionTypeId),
            'That session type no longer exists.');
          s.sessionTypeId = p.sessionTypeId;
        }
        if (p.currentExerciseId !== undefined) {
          if (p.currentExerciseId !== null) {
            findExercise(d, p.currentExerciseId);
            if (!s.exerciseOrder.includes(p.currentExerciseId)) s.exerciseOrder.push(p.currentExerciseId);
          }
          s.currentExerciseId = p.currentExerciseId;
        }
        if (p.exerciseOrder !== undefined) {
          assert(Array.isArray(p.exerciseOrder), 'Invalid exercise order.');
          s.exerciseOrder = p.exerciseOrder.slice();
        }
        return s;
      });
    },

    finishSession(id, { finishedAt } = {}) {
      return write((d) => {
        const s = findSession(d, id);
        // A reopened (edited) workout keeps its original end time.
        s.finishedAt = finishedAt || s.reopenedFinishedAt || nowIso();
        delete s.reopenedFinishedAt;
        return s;
      });
    },

    /** Reopens a finished session for editing. */
    reopenSession(id) {
      return write((d) => {
        assert(!d.sessions.some((s) => !s.finishedAt && s.id !== id), 'Finish the current session first.');
        const s = findSession(d, id);
        if (s.finishedAt) s.reopenedFinishedAt = s.finishedAt;
        s.finishedAt = null;
        return s;
      });
    },

    /** Deletes the session with its sets, milestones and its bodyweight entry. */
    deleteSession(id) {
      return write((d) => {
        d.sessions = d.sessions.filter((s) => s.id !== id);
        d.milestones = d.milestones.filter((m) => m.sessionId !== id);
        d.bodyweights = d.bodyweights.filter((b) => b.sessionId !== id);
        return true;
      });
    },

    /* ---------- Sets ---------- */

    /**
     * Main set: { exerciseId, weightKg (null = bodyweight, negative = assisted), reps, rpe?, note? }
     * Drop set: { parentId, weightKg, reps } (exercise comes from the parent).
     */
    addSet(sessionId, input) {
      return write((d) => {
        const s = findSession(d, sessionId);
        const set = {
          id: newId('set'),
          kind: input.parentId ? 'drop' : 'main',
          parentId: input.parentId || null,
          exerciseId: input.exerciseId,
          weightKg: input.weightKg === undefined ? null : input.weightKg,
          reps: input.reps,
          rpe: input.rpe === undefined ? null : input.rpe,
          note: cleanName(input.note || ''),
          loggedAt: input.loggedAt || nowIso(),
        };
        if (set.kind === 'drop') {
          const parent = s.sets.find((x) => x.id === set.parentId);
          assert(parent && parent.kind === 'main', 'A drop set must belong to a main set.');
          set.exerciseId = parent.exerciseId;
          set.rpe = null;
        } else {
          findExercise(d, set.exerciseId);
          checkRpe(set.rpe);
        }
        checkWeight(set.weightKg);
        checkReps(set.reps);
        s.sets.push(set);
        if (!s.exerciseOrder.includes(set.exerciseId)) s.exerciseOrder.push(set.exerciseId);
        return set;
      });
    },

    /** Editable fields: weightKg, reps, rpe, note. */
    updateSet(sessionId, setId, patch) {
      return write((d) => {
        const s = findSession(d, sessionId);
        const set = s.sets.find((x) => x.id === setId);
        assert(set, 'That set no longer exists.');
        const p = patch || {};
        if (p.weightKg !== undefined) { checkWeight(p.weightKg); set.weightKg = p.weightKg; }
        if (p.reps !== undefined) { checkReps(p.reps); set.reps = p.reps; }
        if (p.rpe !== undefined && set.kind === 'main') { checkRpe(p.rpe); set.rpe = p.rpe; }
        if (p.note !== undefined) set.note = cleanName(p.note);
        return set;
      });
    },

    /** Deleting a main set also deletes its drop sets. */
    deleteSet(sessionId, setId) {
      return write((d) => {
        const s = findSession(d, sessionId);
        const removed = s.sets.filter((x) => x.id === setId || x.parentId === setId).map((x) => x.id);
        s.sets = s.sets.filter((x) => !removed.includes(x.id));
        return removed;
      });
    },

    /* ---------- Milestones (saved PRs) ---------- */

    /** Sorted oldest first. */
    listMilestones({ exerciseId } = {}) {
      return read((d) => d.milestones
        .filter((m) => !exerciseId || m.exerciseId === exerciseId)
        .sort((a, b) => (a.date + (a.loggedAt || '')).localeCompare(b.date + (b.loggedAt || ''))));
    },

    /** Adds milestones found when a set is logged live. */
    addMilestones(list) {
      return write((d) => {
        const added = list.map((m) => ({ id: newId('pr'), ...m }));
        d.milestones.push(...added);
        return added;
      });
    },

    /**
     * Replaces every milestone for one exercise, used after a set is edited or
     * deleted. Milestones that still match the same set and type keep their id.
     */
    replaceExerciseMilestones(exerciseId, list) {
      return write((d) => {
        const old = d.milestones.filter((m) => m.exerciseId === exerciseId);
        const key = (m) => `${m.setId}|${m.type}`;
        const oldByKey = new Map(old.map((m) => [key(m), m]));
        const next = list.map((m) => ({ ...m, exerciseId, id: (oldByKey.get(key(m)) || {}).id || newId('pr') }));
        d.milestones = d.milestones.filter((m) => m.exerciseId !== exerciseId).concat(next);
        return next;
      });
    },

    /* ---------- Bodyweight ---------- */

    listBodyweights() {
      return read((d) => d.bodyweights.slice().sort((a, b) => a.date.localeCompare(b.date)));
    },

    /** With a sessionId, replaces that session's weigh-in. Without, adds a stand-alone weigh-in. */
    logBodyweight({ date, kg, sessionId = null }) {
      return write((d) => {
        assert(typeof kg === 'number' && kg > 0 && kg < 700, 'Enter a bodyweight above 0.');
        let entryDate = date;
        if (sessionId) {
          const s = findSession(d, sessionId);
          entryDate = s.date;
          d.bodyweights = d.bodyweights.filter((b) => b.sessionId !== sessionId);
        }
        entryDate = entryDate || dateKey();
        assert(isDateKey(entryDate), 'Invalid date.');
        const entry = { id: newId('bw'), date: entryDate, kg, sessionId, loggedAt: nowIso() };
        d.bodyweights.push(entry);
        return entry;
      });
    },

    deleteBodyweight(id) {
      return write((d) => { d.bodyweights = d.bodyweights.filter((b) => b.id !== id); return true; });
    },

    /* ---------- Export / import ---------- */

    exportData() {
      return read((d) => ({
        app: 'workout-tracker',
        exportedAt: nowIso(),
        ...d,
      }));
    },

    /** Problems that would stop `obj` from importing (empty array = fine). Does not change anything. */
    checkImport(obj) { return Promise.resolve(validate(obj)); },

    /** Replaces everything with the file's data after checking it. Throws a StoreError listing problems. */
    importData(obj) {
      const problems = validate(obj);
      if (problems.length) {
        return Promise.reject(new StoreError(`This file can't be imported:\n${problems.join('\n')}`));
      }
      return write((d) => {
        const { app, exportedAt, ...data } = obj;
        const next = normalise(data);
        Object.keys(d).forEach((k) => delete d[k]);
        Object.assign(d, next);
        return { sessions: next.sessions.length, exercises: next.exercises.length };
      });
    },

    /** Wipes everything back to a fresh install. */
    resetAll() {
      return write((d) => {
        const fresh = emptyDb();
        Object.keys(d).forEach((k) => delete d[k]);
        Object.assign(d, fresh);
        return true;
      });
    },
  };

  global.Store = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
})(typeof window !== 'undefined' ? window : globalThis);
